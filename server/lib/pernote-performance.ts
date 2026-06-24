import fs from "node:fs";
import path from "node:path";
import { cohensKappa } from "@chart-review/eval-adherence-iaa";
import { PLATFORM_ROOT, readGroundTruth } from "@chart-review/patients";
import { loadCompiledTask } from "@chart-review/tasks";

/** One scored cell: rater `a` (agent) vs rater `b` (reviewer or ground truth). */
export interface CellPair {
  note_id: string;
  field_id: string;
  a: string;
  b: string;
}

export interface PerFieldMetric {
  field_id: string;
  n: number;
  n_correct: number;
  accuracy: number | null;
  kappa: number | null;
}

export interface PerNoteMetrics {
  per_field: PerFieldMetric[];
  macro_accuracy: number | null;
  overall_agreement: number | null;
  disagreements: Array<{ note_id: string; field_id: string; a: string; b: string }>;
}

/** Per-numeric-field scoring spec: a cell counts correct when |a-b| ≤ tolerance. */
export interface NumericFieldSpec { tolerance: number; }

/** PURE: accuracy + Cohen's κ over note×field cells, grouped by field. For
 *  fields listed in `numericFields`, cells match within ±tolerance and κ is
 *  suppressed (a numeric scale isn't a nominal category set). */
export function computePerNoteMetrics(
  pairs: CellPair[],
  fieldIds: string[],
  numericFields?: Record<string, NumericFieldSpec>,
): PerNoteMetrics {
  const isNumeric = (fid: string) => !!numericFields && fid in numericFields;
  const matches = (fid: string, a: string, b: string): boolean => {
    if (isNumeric(fid)) {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) <= numericFields![fid]!.tolerance;
    }
    return a === b;
  };
  const per_field: PerFieldMetric[] = fieldIds.map((fid) => {
    const cells = pairs.filter((p) => p.field_id === fid);
    const n = cells.length;
    const n_correct = cells.filter((c) => matches(fid, c.a, c.b)).length;
    // κ is meaningless for a numeric scale (each value is a distinct nominal
    // category) — compute it only for categorical fields.
    const k = !isNumeric(fid) && cells.length >= 2
      ? cohensKappa(cells.map((c) => ({ rater_a: c.a, rater_b: c.b })))
      : Number.NaN;
    return {
      field_id: fid,
      n,
      n_correct,
      accuracy: n === 0 ? null : n_correct / n,
      kappa: Number.isFinite(k) ? k : null,
    };
  });
  const scored = per_field.filter((f) => f.accuracy != null);
  const macro_accuracy =
    scored.length === 0
      ? null
      : scored.reduce((s, f) => s + (f.accuracy as number), 0) / scored.length;
  const totalN = pairs.length;
  const totalCorrect = pairs.filter((p) => matches(p.field_id, p.a, p.b)).length;
  return {
    per_field,
    macro_accuracy,
    overall_agreement: totalN === 0 ? null : totalCorrect / totalN,
    disagreements: pairs
      .filter((p) => !matches(p.field_id, p.a, p.b))
      .map((p) => ({ note_id: p.note_id, field_id: p.field_id, a: p.a, b: p.b })),
  };
}

/** Read numeric field specs (id → tolerance) off a compiled task. A criterion
 *  declares numeric scoring via answer_schema.type integer/number, with an
 *  optional answer_schema.tolerance (default 0 = exact). */
function numericFieldsOf(taskId: string): Record<string, NumericFieldSpec> {
  const out: Record<string, NumericFieldSpec> = {};
  const task = loadCompiledTask(taskId);
  for (const f of task?.fields ?? []) {
    const schema = (f as { answer_schema?: { type?: string; tolerance?: number } }).answer_schema;
    if (schema?.type === "integer" || schema?.type === "number") {
      const fid = (f as { id?: string; field_id?: string }).id ?? (f as { id?: string; field_id?: string }).field_id;
      if (fid) out[fid] = { tolerance: typeof schema.tolerance === "number" ? schema.tolerance : 0 };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session walker
// ---------------------------------------------------------------------------

interface FA {
  field_id: string;
  encounter_id?: string;
  answer?: unknown;
  source?: string;
  status?: string;
  original_agent_snapshot?: { answer?: unknown };
}
interface RState {
  validated_notes?: string[];
  field_assessments?: FA[];
  patient_id?: string;
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return null; }
}
function asStr(v: unknown): string | null {
  // An empty string is an intentionally-cleared cell ("—" in the grid), not a
  // label — exclude it from scoring rather than counting it as a disagreement.
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

export interface PerNotePerformance {
  task_id: string;
  validated_notes: number;
  field_ids: string[];
  agent_vs_reviewer: PerNoteMetrics;
  agent_vs_gt: PerNoteMetrics;
  reviewer_vs_gt: PerNoteMetrics;
  gt_coverage: { n_with_gt: number; n_total: number };
}

/** Walk a session's review states; score each (note,field) cell where the note
 *  is in validated_notes. Agent = original_agent_snapshot.answer (when the
 *  reviewer edited) else the live answer (untouched agent draft). Reviewer =
 *  the live answer. GT = corpus note_answers when present. */
export function computePerNotePerformance(
  sessionId: string,
  taskId: string,
  fieldIds: string[],
): PerNotePerformance {
  const reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
  const sessionDir = path.join(reviewsRoot, sessionId);
  const arPairs: CellPair[] = [];
  const agPairs: CellPair[] = [];
  const rgPairs: CellPair[] = [];
  let validatedNoteCount = 0;
  let nWithGt = 0;
  let nTotal = 0;

  if (fs.existsSync(sessionDir)) {
    for (const pid of fs.readdirSync(sessionDir)) {
      if (pid.startsWith(".")) continue;
      const state = readJson<RState>(path.join(sessionDir, pid, taskId, "review_state.json"));
      if (!state) continue;
      const validated = new Set(state.validated_notes ?? []);
      const gt = readGroundTruth(pid);
      for (const fa of state.field_assessments ?? []) {
        const noteId = fa.encounter_id;
        if (!noteId || !validated.has(noteId)) continue;
        if (!fieldIds.includes(fa.field_id)) continue;
        const reviewerAns = asStr(fa.answer);
        const agentAns = fa.original_agent_snapshot
          ? asStr(fa.original_agent_snapshot.answer)
          : (fa.source === "agent" ? asStr(fa.answer) : reviewerAns);
        if (agentAns != null && reviewerAns != null) {
          arPairs.push({ note_id: `${pid}:${noteId}`, field_id: fa.field_id, a: agentAns, b: reviewerAns });
        }
        const gtAns = asStr(gt?.note_answers?.[noteId]?.[fa.field_id]);
        nTotal++;
        if (gtAns != null) {
          nWithGt++;
          if (agentAns != null) agPairs.push({ note_id: `${pid}:${noteId}`, field_id: fa.field_id, a: agentAns, b: gtAns });
          if (reviewerAns != null) rgPairs.push({ note_id: `${pid}:${noteId}`, field_id: fa.field_id, a: reviewerAns, b: gtAns });
        }
      }
      validatedNoteCount += validated.size;
    }
  }

  const numericFields = numericFieldsOf(taskId);
  return {
    task_id: taskId,
    validated_notes: validatedNoteCount,
    field_ids: fieldIds,
    agent_vs_reviewer: computePerNoteMetrics(arPairs, fieldIds, numericFields),
    agent_vs_gt: computePerNoteMetrics(agPairs, fieldIds, numericFields),
    reviewer_vs_gt: computePerNoteMetrics(rgPairs, fieldIds, numericFields),
    gt_coverage: { n_with_gt: nWithGt, n_total: nTotal },
  };
}
