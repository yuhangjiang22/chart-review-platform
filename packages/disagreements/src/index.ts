// app/server/disagreements.ts
import fs from "fs";
import path from "path";

export interface EvidenceRef {
  source?: string;
  note_id?: string | null;
  span_offsets?: [number, number] | null;
  verbatim_quote?: string;
  table?: string;       // structured evidence
  row_id?: number;      // structured evidence
  concept_id?: number;
  // Allow any extra fields without complaint:
  [k: string]: unknown;
}

export interface FieldAssessment {
  field_id: string;
  answer: unknown;
  evidence?: EvidenceRef[];
  confidence?: "low" | "medium" | "high";
  rationale?: string;
  [k: string]: unknown;
}

export interface AgentDraft {
  agent_id: string;
  patient_id: string;
  field_assessments: FieldAssessment[];
}

export type DisagreementKind = "hard" | "soft";

/**
 * Per-agent value slot in a disagreement record.
 *
 * - `status: 'answered'` — the agent's field_assessments contains this field_id.
 *   The value may be any string (including 'no_info' or 'not_applicable').
 * - `status: 'skipped'` — the agent's field_assessments does NOT contain this
 *   field_id at all. After the A1 commit gate this should never happen for new
 *   reviews, but older cohort files may still contain this shape.
 */
export interface AgentAnswerSlot {
  value: string | null;
  status: "answered" | "skipped";
}

export interface Disagreement {
  patient_id: string;
  field_id: string;
  kind: DisagreementKind;
  pair: { agent_a: string; agent_b: string };
  /**
   * Rich per-agent answer slots. Use `answers.agent_a.value` and
   * `answers.agent_b.value` for the normalized string answer.
   * `answers.agent_a.status` distinguishes 'answered' from 'skipped'.
   *
   * Note: pre-cluster-3 on-disk disagreements.json files may contain the
   * legacy flat-string shape `answers: { agent_a: "yes", agent_b: "no" }`.
   * The HTTP route GET /api/pilots/:taskId/:iterId/disagreements applies a
   * coercion shim that maps those legacy strings to AgentAnswerSlot objects
   * before sending the response, so clients always receive the current shape.
   */
  answers: { agent_a: AgentAnswerSlot; agent_b: AgentAnswerSlot };
  evidence: { agent_a: EvidenceRef[]; agent_b: EvidenceRef[] };
}

export interface DisagreementSummary {
  pairs_compared: Array<{ agent_a: string; agent_b: string }>;
  disagreements: Disagreement[];
  same_answer_different_evidence_count: number;
  by_criterion: Record<string, { disagreement_count: number; hard_count: number; soft_count: number }>;
}

function evidenceFingerprint(ev: EvidenceRef[] | undefined | null): string {
  if (!Array.isArray(ev)) return "";
  return [...ev]
    .map((e) => {
      if (e.note_id && Array.isArray(e.span_offsets) && e.span_offsets.length === 2) {
        return `note:${e.note_id}:${e.span_offsets[0]}-${e.span_offsets[1]}`;
      }
      if (e.note_id) {
        // Note-anchored but no offsets — fall back to note_id + quote hash
        return `note:${e.note_id}:nooffset:${(e.verbatim_quote ?? "").slice(0, 60)}`;
      }
      if (e.table && e.row_id != null) {
        return `omop:${e.table}:${e.row_id}`;
      }
      // Unknown shape — fingerprint by JSON stringify of stable subset
      return `unknown:${JSON.stringify({ s: e.source, t: e.table, c: e.concept_id })}`;
    })
    .sort()
    .join("|");
}

function normalizeAnswer(a: unknown): string {
  if (a === null || a === undefined) return "no_info";
  if (typeof a === "boolean") return a ? "true" : "false";
  if (typeof a === "number") return String(a);
  if (typeof a === "string") {
    const s = a.trim().toLowerCase();
    // Treat various ways of saying "missing/unknown" as no_info
    if (s === "" || s === "null" || s === "undefined" || s === "n/a" || s === "unknown") return "no_info";
    // Lowercase already-string boolean-ish values to canonical form
    if (s === "true" || s === "yes") return "true";
    if (s === "false" || s === "no") return "false";
    return s;
  }
  return String(a);
}

function classifyMismatch(a: string | null, b: string | null): DisagreementKind | null {
  // Two skipped fields are treated as agreement (both absent = same signal).
  if (a === null && b === null) return null;
  // Normalize nulls (skipped) to "no_info" for the mismatch check so that
  // skipped vs answered still produces a soft disagreement.
  const normA = a ?? "no_info";
  const normB = b ?? "no_info";
  if (normA === normB) return null;
  const noInfoSet = new Set(["no_info", "unsure", ""]);
  if (noInfoSet.has(normA) || noInfoSet.has(normB)) return "soft";
  return "hard";
}

/**
 * Return an AgentAnswerSlot for a given field.
 * If the field is present in `d.field_assessments`, status='answered'.
 * Otherwise, status='skipped' and value=null.
 */
function getAnswerSlot(d: AgentDraft, fieldId: string): AgentAnswerSlot {
  const fa = d.field_assessments.find((x) => x.field_id === fieldId);
  if (!fa) {
    return { value: null, status: "skipped" };
  }
  return { value: normalizeAnswer(fa.answer), status: "answered" };
}

/**
 * Retrieve the evidence array for a given field.
 * This is the only thing `compareDrafts` needs from a FieldAssessment —
 * the answer/status pair is handled by `getAnswerSlot`.
 *
 * If the field is absent in the draft (never assessed), returns an empty array.
 * Note: do NOT use this to read `.answer`; use `getAnswerSlot` instead.
 */
function getEvidence(d: AgentDraft, fieldId: string): EvidenceRef[] {
  const fa = d.field_assessments.find((x) => x.field_id === fieldId);
  return fa?.evidence ?? [];
}

export function compareDrafts(drafts: AgentDraft[]): DisagreementSummary {
  if (drafts.length < 2) {
    return {
      pairs_compared: [],
      disagreements: [],
      same_answer_different_evidence_count: 0,
      by_criterion: {},
    };
  }
  const fieldIds = new Set<string>();
  for (const d of drafts) for (const fa of d.field_assessments) fieldIds.add(fa.field_id);

  const pairs: Array<{ agent_a: string; agent_b: string }> = [];
  for (let i = 0; i < drafts.length; i++) {
    for (let j = i + 1; j < drafts.length; j++) {
      pairs.push({ agent_a: drafts[i].agent_id, agent_b: drafts[j].agent_id });
    }
  }

  const disagreements: Disagreement[] = [];
  let sameAnswerDiffEvidence = 0;

  for (let i = 0; i < drafts.length; i++) {
    for (let j = i + 1; j < drafts.length; j++) {
      const a = drafts[i], b = drafts[j];
      for (const fid of fieldIds) {
        const slotA = getAnswerSlot(a, fid);
        const slotB = getAnswerSlot(b, fid);
        const kind = classifyMismatch(slotA.value, slotB.value);
        if (kind) {
          disagreements.push({
            patient_id: a.patient_id,
            field_id: fid,
            kind,
            pair: { agent_a: a.agent_id, agent_b: b.agent_id },
            answers: { agent_a: slotA, agent_b: slotB },
            evidence: { agent_a: getEvidence(a, fid), agent_b: getEvidence(b, fid) },
          });
        } else if (slotA.status === "answered" && slotB.status === "answered" && slotA.value === slotB.value) {
          // Same answer (both answered the same value) — check evidence fingerprint.
          if (evidenceFingerprint(getEvidence(a, fid)) !== evidenceFingerprint(getEvidence(b, fid))) {
            sameAnswerDiffEvidence++;
          }
        }
      }
    }
  }

  const byCriterion: DisagreementSummary["by_criterion"] = {};
  for (const d of disagreements) {
    const e = byCriterion[d.field_id] ?? { disagreement_count: 0, hard_count: 0, soft_count: 0 };
    e.disagreement_count++;
    if (d.kind === "hard") e.hard_count++;
    else e.soft_count++;
    byCriterion[d.field_id] = e;
  }

  return {
    pairs_compared: pairs,
    disagreements,
    same_answer_different_evidence_count: sameAnswerDiffEvidence,
    by_criterion: byCriterion,
  };
}

/** Read all per-agent drafts under runs/<run_id>/per_patient/<pid>/agents/. */
export function loadAgentDrafts(runDir: string, patientId: string): AgentDraft[] {
  const dir = path.join(runDir, "per_patient", patientId, "agents");
  if (!fs.existsSync(dir)) return [];
  const drafts: AgentDraft[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const agentId = f.replace(/\.json$/, "");
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      drafts.push({
        agent_id: agentId,
        patient_id: patientId,
        field_assessments: Array.isArray(raw.field_assessments) ? raw.field_assessments : [],
      });
    } catch { /* skip malformed */ }
  }
  return drafts;
}

// ── NER (span-shaped) disagreements ──────────────────────────────────
//
// Parallel surface for task_kind="ner". Where compareDrafts compares
// cell-shaped FieldAssessments, compareSpanDrafts compares span lists.
// The underlying math lives in @chart-review/eval-span-iaa; this layer
// just iterates pairs, calls computeSpanIaa, and returns a summary
// shaped for the judge / pilot routes to consume.

import {
  computeSpanIaa,
  type SpanDisagreement,
  type SpanIaaReport,
} from "@chart-review/eval-span-iaa";
import type { SpanLabel } from "@chart-review/platform-types";

export type { SpanDisagreement } from "@chart-review/eval-span-iaa";

export interface AgentSpanDraft {
  agent_id: string;
  patient_id: string;
  span_labels: SpanLabel[];
}

export interface SpanDisagreementSummary {
  task_kind: "ner";
  patient_id: string;
  pairs_compared: Array<{ agent_a: string; agent_b: string }>;
  /** One row per pair × span. Carries the pair identity inline so
   *  consumers can filter by pair without grouping. */
  rows: Array<SpanDisagreement & { pair: { agent_a: string; agent_b: string } }>;
  /** Per-pair aggregate IAA (F1 / κ) from computeSpanIaa. */
  per_pair: Array<{
    agent_a: string; agent_b: string;
    macro_f1: number | undefined;
    tuple_kappa: number | undefined;
  }>;
}

export function compareSpanDrafts(drafts: AgentSpanDraft[]): SpanDisagreementSummary {
  const patientId = drafts[0]?.patient_id ?? "";
  const summary: SpanDisagreementSummary = {
    task_kind: "ner",
    patient_id: patientId,
    pairs_compared: [],
    rows: [],
    per_pair: [],
  };
  if (drafts.length < 2) return summary;

  for (let i = 0; i < drafts.length; i++) {
    for (let j = i + 1; j < drafts.length; j++) {
      const a = drafts[i]!;
      const b = drafts[j]!;
      const pair = { agent_a: a.agent_id, agent_b: b.agent_id };
      const iaa: SpanIaaReport = computeSpanIaa(a.span_labels, b.span_labels);
      summary.pairs_compared.push(pair);
      summary.per_pair.push({
        agent_a: a.agent_id, agent_b: b.agent_id,
        macro_f1: iaa.macro_f1,
        tuple_kappa: iaa.tuple_kappa,
      });
      // Only emit non-agree rows — judge + UI surface disagreements,
      // not the (typically larger) set of full agreements.
      for (const row of iaa.pairs) {
        if (row.kind === "agree") continue;
        summary.rows.push({ ...row, pair });
      }
    }
  }
  return summary;
}

/** Read NER agent drafts under runs/<run_id>/per_patient/<pid>/agents/.
 *  Parallel to loadAgentDrafts; reads `span_labels` instead of
 *  `field_assessments`. */
export function loadAgentSpanDrafts(runDir: string, patientId: string): AgentSpanDraft[] {
  const dir = path.join(runDir, "per_patient", patientId, "agents");
  if (!fs.existsSync(dir)) return [];
  const drafts: AgentSpanDraft[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const agentId = f.replace(/\.json$/, "");
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
        span_labels?: SpanLabel[];
      };
      drafts.push({
        agent_id: agentId,
        patient_id: patientId,
        span_labels: Array.isArray(raw.span_labels) ? raw.span_labels : [],
      });
    } catch { /* skip malformed */ }
  }
  return drafts;
}
