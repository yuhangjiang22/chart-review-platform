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

export type EntityRecord = Record<string, unknown>;

export interface PerNoteEntitySpec {
  value_key: string;
  attributes: Record<string, { enum?: string[] }>;
}

export interface PerNoteField {
  field_id: string;
  enum: string[];
  prompt?: string;
  /** "integer"/"number" → numeric field (answer kept as a number, validated
   *  within [min,max]); "string" → free-text single value; "array" → entity
   *  list (answer kept as EntityRecord[], one record per substance/vaccine).
   *  Absent + non-empty enum → categorical. */
  type?: "integer" | "number" | "string" | "array";
  min?: number;
  max?: number;
  /** For type === "array": the entity record shape. */
  entity?: PerNoteEntitySpec;
}

export interface PerNoteFieldResult {
  field_id: string;
  answer?: string | number | EntityRecord[];
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
      const schema = (f as {
        answer_schema?: {
          enum?: unknown[]; type?: string; minimum?: number; maximum?: number;
          entity?: { value_key?: string; attributes?: Record<string, { enum?: unknown[] } | undefined> };
        };
      }).answer_schema;
      const en = Array.isArray(schema?.enum) ? schema!.enum!.map((v) => String(v)) : [];
      const t = schema?.type;
      const type: PerNoteField["type"] =
        t === "integer" || t === "number" || t === "string" || t === "array" ? (t as PerNoteField["type"]) : undefined;
      let entity: PerNoteEntitySpec | undefined;
      if (t === "array" && schema?.entity) {
        const attrs: Record<string, { enum?: string[] }> = {};
        for (const [k, v] of Object.entries(schema.entity.attributes ?? {})) {
          const ae = (v as { enum?: unknown[] } | undefined)?.enum;
          attrs[k] = { enum: Array.isArray(ae) ? ae.map(String) : undefined };
        }
        entity = { value_key: schema.entity.value_key ?? "value", attributes: attrs };
      }
      return {
        field_id: id,
        enum: en,
        prompt: (f as { prompt?: string }).prompt,
        type,
        min: typeof schema?.minimum === "number" ? schema.minimum : undefined,
        max: typeof schema?.maximum === "number" ? schema.maximum : undefined,
        entity,
      };
    })
    // Extractable = categorical (enum), numeric (integer/number), free-text
    // (string), or entity-list (array). Drop anything else (nothing to ask for).
    .filter((f) => f.enum.length > 0 || f.type === "integer" || f.type === "number" || f.type === "string" || f.type === "array");
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
    const rawAns = raw?.answer;
    let answer: string | number | EntityRecord[] | undefined;
    if (f.type === "array" && f.entity) {
      // Entity-list field: answer is an array of records. Keep records with a
      // non-empty value_key + Supporting_Evidence; drop off-enum attributes.
      // A present-but-empty array (`[]`) is a valid "none documented".
      if (Array.isArray(rawAns)) {
        const vk = f.entity.value_key;
        const clean: EntityRecord[] = [];
        for (const item of rawAns) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const rec = item as EntityRecord;
          const val = rec[vk];
          const se = rec.Supporting_Evidence;
          if (val == null || String(val).trim() === "") continue;
          if (se == null || String(se).trim() === "") continue;
          const outRec: EntityRecord = { [vk]: String(val).trim(), Supporting_Evidence: String(se).trim() };
          for (const [k, spec] of Object.entries(f.entity.attributes)) {
            const av = rec[k];
            if (av == null || String(av).trim() === "") continue;
            if (spec.enum && !spec.enum.includes(String(av).trim())) continue; // drop off-enum attr
            outRec[k] = String(av).trim();
          }
          clean.push(outRec);
        }
        answer = clean;
      }
    } else if (rawAns != null && rawAns !== "") {
      if (f.enum.length > 0) {
        // Categorical: keep only an on-list value.
        const s = String(rawAns);
        answer = f.enum.includes(s) ? s : undefined;
      } else if (f.type === "integer" || f.type === "number") {
        // Numeric: coerce to a number, keep only finite + in-range (and integer
        // for integer fields). Out-of-range / non-numeric is dropped.
        const n = typeof rawAns === "number" ? rawAns : Number(String(rawAns).trim());
        const ok =
          Number.isFinite(n) &&
          (f.type !== "integer" || Number.isInteger(n)) &&
          (f.min === undefined || n >= f.min) &&
          (f.max === undefined || n <= f.max);
        answer = ok ? n : undefined;
      } else if (f.type === "string") {
        // Free-text single value: keep any non-empty string.
        const s = String(rawAns).trim();
        answer = s.length > 0 ? s : undefined;
      }
    }
    const conf = raw?.confidence;
    return {
      field_id: f.field_id,
      answer,
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

function describeField(f: PerNoteField): string {
  if (f.type === "array" && f.entity) {
    const attrs = Object.entries(f.entity.attributes)
      .map(([k, s]) => (s.enum ? `${k}(${s.enum.join("|")})` : k))
      .join(", ");
    return `(JSON ARRAY of entity objects — one per item documented in THIS note, [] if none. Each object: {"${f.entity.value_key}": <verbatim>, "Supporting_Evidence": <smallest verbatim span from THIS note>${attrs ? `, optional: ${attrs}` : ""}})`;
  }
  if (f.enum.length > 0) return `(one of: ${f.enum.map((e) => JSON.stringify(e)).join(", ")})`;
  if (f.type === "integer" || f.type === "number") {
    const range = f.min !== undefined && f.max !== undefined ? ` ${f.min}–${f.max}` : "";
    return `(${f.type}${range} — the numeric score; omit if not documented)`;
  }
  if (f.type === "string") return `(free-text value; omit if not documented)`;
  return "";
}

function buildUserPrompt(noteId: string, noteText: string, fields: PerNoteField[]): string {
  const fieldLines = fields.map((f) => `  - ${f.field_id} ${describeField(f)}${f.prompt ? ` — ${f.prompt}` : ""}`).join("\n");
  return [
    `Note id: ${noteId}`,
    "",
    "Fields to label. For each field the value must match its type: a listed",
    "value for categorical fields, the numeric score (a number) for numeric",
    "fields, or the free-text value for free-text fields. OMIT a field (or use",
    "null) when THIS note does not document it.",
    fieldLines,
    "",
    "Return ONLY a JSON object keyed by field_id, each value an object",
    `{ "answer": <value of the field's type, or null>, "confidence": "low"|"medium"|"high", "evidence_quote": <smallest verbatim span from THIS note, or "">, "rationale": <one sentence> }.`,
    "For an ARRAY (entity-list) field, `answer` is the JSON array of entity",
    "objects and each entity carries its own `Supporting_Evidence` (the top-level",
    "`evidence_quote` may be \"\"). Use [] when THIS note documents none.",
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
  const byId = new Map(fields.map((f) => [f.field_id, f]));
  const out: PerNoteFieldResult[] = parsed.map((p) => {
    const f = byId.get(p.field_id);
    // Entity-list field: resolve EACH entity's Supporting_Evidence; drop any
    // entity whose evidence is not faithful (anti-fabrication), and collect the
    // verified spans as the assessment's evidence[].
    if (f?.type === "array" && Array.isArray(p.answer)) {
      const evidence: NoteEvidence[] = [];
      const kept: EntityRecord[] = [];
      for (const ent of p.answer as EntityRecord[]) {
        const q = typeof ent.Supporting_Evidence === "string" ? ent.Supporting_Evidence : "";
        const ev = resolveEvidence(opts.patientId, opts.noteId, noteText, q);
        if (ev) { evidence.push(ev); kept.push(ent); }
      }
      return { ...p, answer: kept, evidence: evidence.length ? evidence : undefined };
    }
    const ev = p.evidence_quote ? resolveEvidence(opts.patientId, opts.noteId, noteText, p.evidence_quote) : null;
    return { ...p, evidence: ev ? [ev] : undefined };
  });
  return { fields: out, usage: res.usage };
}
