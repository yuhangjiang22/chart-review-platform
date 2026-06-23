/**
 * Direct-LLM per-note phenotype extractor.
 *
 * One LLM round-trip per note. The model returns, for each leaf field, an
 * answer drawn from that field's answer_schema.enum plus a short evidence
 * quote + rationale, scoped to THIS note only. Each quote is faithfulness-
 * checked against the note bytes; quotes truly absent have their evidence
 * dropped (the answer is kept, flagged low-evidence) — offsets are never
 * fabricated.
 */
import { callLlm, type LlmEndpoint, type LlmUsage } from "@chart-review/pipeline-extract-ner";
import { verifyEvidence, type NoteEvidence } from "@chart-review/faithfulness";
import { readNote } from "@chart-review/patients";
import type { CompiledTask } from "@chart-review/tasks";

export interface PerNoteField {
  field_id: string;
  enum: string[];
  prompt?: string;
}

export interface PerNoteFieldResult {
  field_id: string;
  answer?: string;
  confidence?: "low" | "medium" | "high";
  evidence?: NoteEvidence[];
  rationale?: string;
  /** Raw model quote before faithfulness resolution; the orchestrator resolves
   *  it into `evidence`. parseLabelResponse populates this; the final result
   *  keeps it for transparency. */
  evidence_quote?: string;
}

export interface ExtractLabelsResult {
  fields: PerNoteFieldResult[];
  usage?: LlmUsage;
  error?: string;
}

export interface ExtractLabelsOpts {
  patientId: string;
  task: CompiledTask;
  noteId: string;
  endpoint: LlmEndpoint;
  /** The per-note prompt body (skill references/pernote_prompt.md). */
  promptPreamble: string;
  /** Injectable for tests; defaults to the real callLlm. */
  call?: typeof callLlm;
}

/** Pull EXTRACTED leaf fields + their enums off the compiled task. Fields with
 *  a `derivation` are computed (not extracted), so they are excluded — the
 *  model never labels a derived field; it is recomputed from its leaf inputs. */
export function fieldsFromTask(task: CompiledTask): PerNoteField[] {
  return (task.fields ?? [])
    .filter((f) => !(f as { derivation?: string }).derivation)
    .map((f) => {
      const id = (f as { field_id?: string; id?: string }).field_id ?? (f as { id: string }).id;
      const schema = (f as { answer_schema?: { enum?: unknown[] } }).answer_schema;
      const en = Array.isArray(schema?.enum) ? schema!.enum!.map((v) => String(v)) : [];
      return { field_id: id, enum: en, prompt: (f as { prompt?: string }).prompt };
    })
    .filter((f) => f.enum.length > 0);
}

/** PURE: parse the model's JSON into one result per requested field, keeping
 *  only enum-valid answers. Tolerates markdown fences and object- or array-shaped
 *  responses. Always returns exactly one entry per field in `fields`. */
export function parseLabelResponse(text: string, fields: PerNoteField[]): PerNoteFieldResult[] {
  let s = (text ?? "").trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1]!.trim();
  let obj: Record<string, { answer?: unknown; confidence?: unknown; evidence_quote?: unknown; rationale?: unknown }> = {};
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        const fid = (row as { field_id?: string })?.field_id;
        if (fid) obj[fid] = row as never;
      }
    } else if (parsed && typeof parsed === "object") {
      obj = parsed as never;
    }
  } catch { /* leave obj empty → all answers undefined */ }

  return fields.map((f) => {
    const raw = obj[f.field_id];
    const ans = raw?.answer != null ? String(raw.answer) : undefined;
    const valid = ans != null && f.enum.includes(ans);
    const conf = raw?.confidence;
    return {
      field_id: f.field_id,
      // An out-of-enum answer is dropped (left undefined) rather than persisted.
      answer: valid ? ans : undefined,
      confidence: conf === "low" || conf === "medium" || conf === "high" ? conf : undefined,
      rationale: raw?.rationale != null ? String(raw.rationale) : undefined,
      evidence: undefined,
      evidence_quote: raw?.evidence_quote != null ? String(raw.evidence_quote) : undefined,
    };
  });
}

/** Build a NoteEvidence for a quote and run it through the faithfulness gate.
 *  Returns the verified evidence (with corrected offsets) or null when the quote
 *  is genuinely absent from the note. */
export function resolveEvidence(patientId: string, noteId: string, noteText: string, quote: string): NoteEvidence | null {
  if (!quote || !quote.trim()) return null;
  const guess = noteText.indexOf(quote);
  const ev: NoteEvidence = {
    source: "note",
    note_id: noteId,
    span_offsets: guess >= 0 ? [guess, guess + quote.length] : [0, 0],
    verbatim_quote: quote,
  };
  const res = verifyEvidence(patientId, ev);
  if (res.status === "fail") return null;
  if (res.corrected_offsets) ev.span_offsets = res.corrected_offsets;
  return ev;
}

function buildUserPrompt(noteId: string, noteText: string, fields: PerNoteField[]): string {
  const fieldLines = fields.map((f) => `  - ${f.field_id} (allowed: ${f.enum.map((e) => JSON.stringify(e)).join(", ")})${f.prompt ? ` — ${f.prompt}` : ""}`).join("\n");
  return [
    `Note id: ${noteId}`,
    "",
    "Fields to label (answer MUST be one of the allowed values for each):",
    fieldLines,
    "",
    "Return ONLY a JSON object keyed by field_id, each value an object",
    `{ "answer": <one allowed value>, "confidence": "low"|"medium"|"high", "evidence_quote": <smallest verbatim span from THIS note, or "">, "rationale": <one sentence> }.`,
    "No prose, no markdown fences.",
    "",
    "--- NOTE TEXT ---",
    noteText,
    "--- END NOTE ---",
  ].join("\n");
}

/** Orchestrator: one LLM call for one note, returning verified per-field results. */
export async function extractLabelsForNote(opts: ExtractLabelsOpts): Promise<ExtractLabelsResult> {
  const fields = fieldsFromTask(opts.task);
  let noteText: string;
  try {
    noteText = readNote(opts.patientId, `${opts.noteId}.txt`);
  } catch (e) {
    return { fields: [], error: `read_note failed for ${opts.noteId}: ${(e as Error).message}` };
  }
  const call = opts.call ?? callLlm;
  let res;
  try {
    res = await call(opts.endpoint, opts.promptPreamble, buildUserPrompt(opts.noteId, noteText, fields), 2048);
  } catch (e) {
    return { fields: [], error: `LLM call failed: ${(e as Error).message}` };
  }
  const parsed = parseLabelResponse(res.text, fields);
  const out: PerNoteFieldResult[] = parsed.map((p) => {
    const ev = p.evidence_quote ? resolveEvidence(opts.patientId, opts.noteId, noteText, p.evidence_quote) : null;
    return { ...p, evidence: ev ? [ev] : undefined };
  });
  return { fields: out, usage: res.usage };
}
