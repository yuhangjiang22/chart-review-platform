/**
 * Direct-LLM NER extractor (no agent loop, no MCP tools).
 *
 * One Azure Responses API call per note. The model returns a JSON
 * array of candidate spans; the server validates each via
 * locateInSource (offsets + faithfulness gate) and writes them
 * through setSpanLabel — same write path the agent flow uses, just
 * called from the server instead of as MCP tool calls.
 *
 * Cost target: ~$0.02/note (vs ~$2/note for the agent loop). The
 * skill content + YAMLs are inlined into the system prompt; Azure's
 * prompt cache covers the prefix across notes within a run.
 */

import fs from "node:fs";
import path from "node:path";
import {
  loadOntology, listEntityTypes, locateInSource,
} from "@chart-review/ontology";
import { setSpanLabel, type NerMcpSession } from "@chart-review/mcp-core-ner";
import { guidelineDir } from "@chart-review/rubric";
import type { CompiledTask } from "@chart-review/tasks";
import { readNote } from "@chart-review/patients";
import { loadRolePreset } from "@chart-review/agent-specs";
import { normalizeSpanWithLLM, spanContext } from "./normalize-span.js";

interface CandidateSpan {
  text?: string;
  anchor?: string;
  entity_type?: string;
  // concept_name / status no longer requested in pass 1 — the
  // mapping pass (normalizeSpanWithLLM) decides those per span.
}

export interface DirectExtractOpts {
  patientId: string;
  task: CompiledTask;
  noteId: string;
  ontologyPath: string;
  reviewsRoot: string;
  sessionId: string;
  azureBaseUrl: string;
  azureApiKey: string;
  model?: string;
  /** Provider for the mapping pass (`normalizeSpanWithLLM`). Defaults
   *  to the same value used elsewhere. */
  provider?: "codex" | "claude";
  /** Agent role preset id (default | skeptical | comprehensive | …).
   *  The role's prose is prepended to BOTH passes' system prompts so
   *  multi-agent runs produce genuinely different interpretations of
   *  the same chart. Falls back to no prefix when absent or unknown. */
  rolePreset?: string;
}

export interface DirectExtractResult {
  ok: boolean;
  spans_written: number;
  candidates_rejected: number;
  rejection_reasons: string[];
  /** First-pass usage (per-note identification). */
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  /** Aggregate mapping-pass usage (sum across all spans normalized). */
  normalize_usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number; n_calls: number };
  error?: string;
}

function readEntityTypeGuidanceYamls(taskId: string): string {
  const dir = path.join(guidelineDir(taskId), "references", "entity_type_guidance");
  if (!fs.existsSync(dir)) return "";
  const blocks: string[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".yaml")) continue;
    try {
      const body = fs.readFileSync(path.join(dir, f), "utf8");
      blocks.push(`### ${f}\n${body}`);
    } catch { /* skip */ }
  }
  return blocks.join("\n\n");
}

/** Read the role-preset prose if a valid preset id is provided. Returns
 *  empty string when unset or unknown (no front-matter, no exceptions). */
function rolePromptOrEmpty(presetId: string | undefined): string {
  if (!presetId) return "";
  try { return loadRolePreset(presetId).role_prompt.trim(); } catch { return ""; }
}

function buildSystemPrompt(
  task: CompiledTask,
  entityTypes: string[],
  yamlBlock: string,
  rolePrompt: string,
): string {
  const lines: string[] = [];
  if (rolePrompt) {
    lines.push("--- Reviewer role framing ---");
    lines.push(rolePrompt);
    lines.push("--- End role framing ---");
    lines.push("");
  }
  return [
    ...lines,
    "You are indexing biomedical entity spans in a clinical note for an IRB-approved annotation study.",
    "Goal: per-entity-type inter-rater reliability against a BSO-AD-style ontology.",
    "",
    `Ontology entity_types (use ONLY these):`,
    ...entityTypes.map((t) => `  - ${t}`),
    "",
    "Per-entity-type guidance (verbatim from the methodologist):",
    "",
    yamlBlock || "(no per-entity-type YAMLs available)",
    "",
    "Anchoring rules:",
    "- `text`: the entity value verbatim from the note.",
    "- `anchor`: a verbatim substring of the note that CONTAINS `text` AND is unique in the note.",
    "  For short/ambiguous values (e.g. '58'), extend the anchor with surrounding context ('age 58').",
    "  For unambiguous long entities, anchor == text.",
    "",
    "IDENTIFICATION PASS — do NOT map to ontology concepts here. A second LLM pass",
    "handles concept_name selection per span against the actual ontology list.",
    "",
    "Output: pure JSON array. Each element:",
    `  { "text": string, "anchor": string, "entity_type": string }`,
    "",
    "Return ONLY the JSON array — no commentary, no markdown fences, no extra text. Empty array is acceptable if nothing applies.",
    `Task id: ${task.task_id}.`,
  ].join("\n");
}

function buildUserPrompt(noteId: string, noteContent: string): string {
  return [
    `Note ID: ${noteId}`,
    "",
    "--- BEGIN NOTE ---",
    noteContent,
    "--- END NOTE ---",
    "",
    "Return the JSON array now.",
  ].join("\n");
}

function parseSpans(text: string): CandidateSpan[] {
  // Strip markdown fences if the model wrapped them despite instructions.
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1]!.trim();
  // If the model wrapped in {"spans": [...]} shape, extract.
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed as CandidateSpan[];
    if (parsed && Array.isArray((parsed as { spans?: CandidateSpan[] }).spans)) {
      return (parsed as { spans: CandidateSpan[] }).spans;
    }
  } catch {
    /* fall through */
  }
  return [];
}

export async function extractSpansDirect(opts: DirectExtractOpts): Promise<DirectExtractResult> {
  // Read the note from disk (same path the MCP server uses).
  const noteFilename = opts.noteId.endsWith(".txt") ? opts.noteId : `${opts.noteId}.txt`;
  let noteContent: string;
  try {
    noteContent = readNote(opts.patientId, noteFilename);
  } catch (e) {
    return {
      ok: false, spans_written: 0, candidates_rejected: 0, rejection_reasons: [],
      error: `note read failed: ${(e as Error).message}`,
    };
  }

  // Build prompts.
  const onto = loadOntology(opts.ontologyPath);
  const entityTypes = listEntityTypes(onto).entity_types;
  const yamls = readEntityTypeGuidanceYamls(opts.task.task_id);
  const rolePrompt = rolePromptOrEmpty(opts.rolePreset);
  const systemPrompt = buildSystemPrompt(opts.task, entityTypes, yamls, rolePrompt);
  const userPrompt = buildUserPrompt(opts.noteId, noteContent);

  // Direct Azure Responses API call (no streaming, no agent loop).
  const url = `${opts.azureBaseUrl}/responses`;
  let respBody: {
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": opts.azureApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? "gpt-5.2",
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: userPrompt }] },
        ],
        max_output_tokens: 4096,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      return {
        ok: false, spans_written: 0, candidates_rejected: 0, rejection_reasons: [],
        error: `Azure HTTP ${r.status}: ${body.slice(0, 400)}`,
      };
    }
    respBody = (await r.json()) as typeof respBody;
  } catch (e) {
    return {
      ok: false, spans_written: 0, candidates_rejected: 0, rejection_reasons: [],
      error: `Azure fetch failed: ${(e as Error).message}`,
    };
  }

  if (respBody.error) {
    return {
      ok: false, spans_written: 0, candidates_rejected: 0, rejection_reasons: [],
      error: `Azure error: ${respBody.error.message ?? JSON.stringify(respBody.error)}`,
      usage: respBody.usage,
    };
  }

  // Pull the message text out of the responses-API shape.
  let outputText = "";
  for (const item of respBody.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string") outputText += c.text;
    }
  }

  const candidates = parseSpans(outputText);
  const session: NerMcpSession = {
    patientId: opts.patientId,
    task: opts.task,
    sessionId: opts.sessionId,
    ontologyPath: opts.ontologyPath,
    reviewsRoot: opts.reviewsRoot,
  };

  let written = 0;
  let rejected = 0;
  const reasons: string[] = [];
  const normAgg = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, n_calls: 0 };

  // Cache the per-entity-type concept list (id+label only) so each
  // mapping call gets the same array reference — Azure / Claude
  // prompt-cache the system prefix at provider-side too.
  const conceptsByType = new Map<string, Array<{ id: string; label: string }>>();
  for (const et of entityTypes) {
    const block = onto.get(et);
    conceptsByType.set(
      et,
      (block?.concepts ?? []).map((c) => ({ id: c.id, label: c.label })),
    );
  }

  for (const c of candidates) {
    if (!c.text || !c.entity_type) { rejected++; reasons.push("missing text/entity_type"); continue; }
    if (!entityTypes.includes(c.entity_type)) {
      rejected++; reasons.push(`unknown entity_type=${c.entity_type}`);
      continue;
    }
    const anchor = c.anchor ?? c.text;
    const loc = locateInSource(noteContent, anchor, c.text);
    if (!loc.found) { rejected++; reasons.push(loc.message ?? "locate failed"); continue; }

    // ── Mapping pass: per-span LLM call with the actual concept list ──
    const context = spanContext(noteContent, loc.start, loc.end, 150);
    const mapped = await normalizeSpanWithLLM({
      text: c.text,
      context,
      entityType: c.entity_type,
      concepts: conceptsByType.get(c.entity_type) ?? [],
      provider: opts.provider,
      azureBaseUrl: opts.azureBaseUrl,
      azureApiKey: opts.azureApiKey,
      model: opts.model,
      rolePrompt,
    });
    if (mapped.usage) {
      normAgg.input_tokens       += mapped.usage.input_tokens ?? 0;
      normAgg.cached_input_tokens += mapped.usage.cached_input_tokens ?? 0;
      normAgg.output_tokens      += mapped.usage.output_tokens ?? 0;
      normAgg.n_calls++;
    }

    // setSpanLabel re-validates faithfulness server-side; reuse it.
    const result = await setSpanLabel(session, {
      note_id: opts.noteId,
      text: c.text,
      anchor,
      start: loc.start,
      end: loc.end,
      entity_type: c.entity_type,
      concept_name: mapped.concept_name,
      status: mapped.status,
    });
    if (result.isError) {
      rejected++;
      const msg = result.content?.[0]?.type === "text" ? result.content[0].text : "setSpanLabel failed";
      reasons.push(String(msg).slice(0, 120));
    } else {
      written++;
    }
  }

  return {
    ok: true,
    spans_written: written,
    candidates_rejected: rejected,
    rejection_reasons: reasons,
    usage: respBody.usage,
    normalize_usage: normAgg,
  };
}
