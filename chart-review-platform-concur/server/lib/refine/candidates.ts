// refine/candidates.ts — Task S1 of the self-refinement increment.
//
// READ-ONLY foundation. Collect agent-vs-human disagreements for a validated
// phenotype iter, attribute each via the judge's classification_hint, and
// cluster by criterion (field_id). No LLM calls, no writes, no rubric changes.
//
// This is the ① data of the proposal card (the "what was wrong" section).
// S2 will consume only the guideline_gap + true_ambiguity examples; S1 returns
// EVERYTHING tagged so agent_error / unjudged cells are visible, not silently
// dropped.
//
// The agent-vs-human join MIRRORS server/performance-routes.ts computePerformance:
//   - human gold      = reviewer-decided field_assessments (source==="reviewer")
//                        on a `reviewer_validated` review_state, leaf fields only.
//   - agent answer     = per-field, from the run-chain drafts at
//                        var/runs/<run>/per_patient/<pid>/agents/<aid>.json;
//                        MOST-RECENT run that drafted the field wins.
//   - a mismatch (agent answer ≠ human answer) = a disagreement.
//
// Attribution: join the judge's classification_hint + reasoning from the iter's
// judge_analyses.json for the (patient, field) cell. The judge's hint uses
// agent_a_error / agent_b_error (per-side); we collapse those to "agent_error"
// for the cluster counts (the cluster is per-field, not per-side). guideline_gap
// / true_ambiguity / n_a pass through; cells with no judge record → "unjudged".

import fs from "node:fs";
import path from "node:path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { loadCompiledTask } from "@chart-review/tasks";
import { loadCriteria, type CriterionFromSkill } from "../domain/rubric/index.js";
import { listPilotIterations } from "../domain/iter/index.js";
import { readJudgeAnalyses } from "../judge-batch.js";
import type { EvidenceRef } from "@chart-review/disagreements";

// ── Public shapes ────────────────────────────────────────────────────────────

/** A single agent-vs-human mismatch, with the reviewer's cited evidence and
 *  the judge's attribution (if the cell was judged). */
export interface RefinementExample {
  patient_id: string;
  agent_id: string;
  /** Reviewer's cited note for this field (first note-anchored evidence ref). */
  note_id: string | null;
  /** Reviewer's cited excerpt (verbatim_quote) for this field. */
  excerpt: string | null;
  /** Reviewer's cited span offsets for this field. */
  offsets: [number, number] | null;
  agent_answer: unknown;
  reviewer_answer: unknown;
  /** Collapsed attribution tag for this cell. `agent_a_error`/`agent_b_error`
   *  are folded to "agent_error"; cells with no judge record → "unjudged". */
  classification_hint:
    | "guideline_gap"
    | "true_ambiguity"
    | "agent_error"
    | "n_a"
    | "unjudged";
  /** The judge's reasoning for this cell, if judged. */
  judge_reasoning: string | null;
}

export interface RefinementCluster {
  field_id: string;
  /** The criterion's current definition (prompt + definition + extraction
   *  guidance), for the downstream refiner (S2). Null if the criterion is no
   *  longer in the rubric. */
  criterion_def: string | null;
  /** The criterion's allowed answers (answer_schema.enum), for the S3 held-out
   *  extractor prompt. Null when the criterion has no enum (free-form / numeric)
   *  or is no longer in the rubric. */
  answer_enum: string[] | null;
  examples: RefinementExample[];
  n_guideline_gap: number;
  n_true_ambiguity: number;
  n_agent_error: number;
  n_unjudged: number;
}

export interface RefinementCandidates {
  task_id: string;
  iter_id: string;
  session_id: string;
  n_validated_patients: number;
  clusters: RefinementCluster[];
  /** Per-field reviewer gold across ALL validated patients (not just
   *  disagreements): `field_id → { patient_id → reviewer_answer }`. The S3
   *  held-out re-score needs gold for held-out patients, which by definition
   *  the disagreement clusters don't all contain. */
  gold_by_field: Record<string, Record<string, unknown>>;
  /** Set when the task is not a phenotype task (NER/adherence are later
   *  increments). When present, `clusters` is empty. */
  unsupported?: { task_kind: string; reason: string };
}

export interface CollectOpts {
  sessionId: string;
  taskId: string;
  iterId: string;
  /** When set, disagreement EXAMPLES are restricted to these patient ids — the
   *  S3 refine set. Held-out patients' disagreements are excluded so the
   *  refiner never sees them (anti-leakage). `gold_by_field` still spans ALL
   *  validated patients (the held-out re-score needs held-out gold), and
   *  `n_validated_patients` still counts the full validated corpus; only the
   *  cluster `examples` (+ their counts) are filtered. Absent = no filter (S1
   *  behavior). */
  examplePatientFilter?: Set<string>;
}

// ── Internal helpers (mirror computePerformance) ───────────────────────────────

interface FieldAssessment {
  field_id: string;
  answer?: unknown;
  source?: string;
  status?: string;
  evidence?: EvidenceRef[];
}
interface ReviewState {
  field_assessments?: FieldAssessment[];
  imported_from_run?: string;
  review_status?: string;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function answersEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** A field is human gold only when a human decided it (reviewer-sourced).
 *  Same predicate as computePerformance.isHumanDecided. */
function isHumanDecided(fa: FieldAssessment): boolean {
  return fa.source === "reviewer" || fa.status === "approved" || fa.status === "overridden";
}

/** First note-anchored evidence ref on a reviewer field_assessment, normalized
 *  to (note_id, excerpt, offsets). */
function firstNoteEvidence(
  fa: FieldAssessment,
): { note_id: string | null; excerpt: string | null; offsets: [number, number] | null } {
  for (const e of fa.evidence ?? []) {
    if (e.note_id) {
      const offsets =
        Array.isArray(e.span_offsets) && e.span_offsets.length === 2
          ? ([Number(e.span_offsets[0]), Number(e.span_offsets[1])] as [number, number])
          : null;
      return {
        note_id: e.note_id,
        excerpt: typeof e.verbatim_quote === "string" ? e.verbatim_quote : null,
        offsets,
      };
    }
  }
  return { note_id: null, excerpt: null, offsets: null };
}

/** Build a compact criterion definition string for the downstream refiner. */
function criterionDef(c: CriterionFromSkill | undefined): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (typeof c.prompt === "string" && c.prompt.trim()) parts.push(c.prompt.trim());
  const def = c.guidance_prose?.definition;
  if (typeof def === "string" && def.trim()) parts.push(def.trim());
  if (typeof c.extraction_guidance === "string" && c.extraction_guidance.trim()) {
    parts.push(c.extraction_guidance.trim());
  }
  const joined = parts.join("\n\n").trim();
  return joined.length > 0 ? joined : null;
}

/** Extract the criterion's allowed-answer enum (answer_schema.enum) as a
 *  string[] for the S3 extractor prompt. Returns null when there's no enum
 *  (free-form / numeric criteria) or the criterion is missing. */
function answerEnum(c: CriterionFromSkill | undefined): string[] | null {
  const schema = c?.answer_schema as { enum?: unknown } | undefined;
  const e = schema?.enum;
  if (!Array.isArray(e) || e.length === 0) return null;
  return e.map((v) => String(v));
}

/** Collapse the judge's per-side classification_hint to the cluster-level tag. */
function collapseHint(
  hint: string | undefined,
): RefinementExample["classification_hint"] {
  switch (hint) {
    case "guideline_gap":
      return "guideline_gap";
    case "true_ambiguity":
      return "true_ambiguity";
    case "agent_a_error":
    case "agent_b_error":
    case "agent_error": // tolerate a pre-collapsed value if it ever appears
      return "agent_error";
    default:
      // "n_a" or any unknown hint → n_a (the cell WAS judged, just not actionable)
      return "n_a";
  }
}

/** Resolve the run chain for an iter, most-recent first, mirroring
 *  computePerformance's run-override branch. Walks the session's non-abandoned
 *  iters with a run_id, keeps those at or before the target iter, newest first. */
export function runChainForIter(
  taskId: string,
  sessionId: string,
  iterId: string,
): string[] {
  const sessionIters = listPilotIterations(taskId)
    .filter((i) => i.session_id === sessionId && i.state !== "abandoned" && i.run_id)
    .sort((a, b) => b.iter_num - a.iter_num); // most-recent first
  const target = sessionIters.find((i) => i.iter_id === iterId);
  if (!target) {
    // iter not in this session's chain — fall back to its own run if known.
    const standalone = listPilotIterations(taskId).find((i) => i.iter_id === iterId);
    return standalone?.run_id ? [standalone.run_id] : [];
  }
  return sessionIters
    .filter((i) => i.iter_num <= target.iter_num)
    .map((i) => i.run_id as string);
}

// ── Core join (unit-testable) ──────────────────────────────────────────────────

export interface BuildClustersInput {
  /** var/reviews/<sessionId> */
  sessionDir: string;
  /** var/runs */
  runsDir: string;
  taskId: string;
  /** Leaf criterion field_ids to score (derived fields excluded). */
  leafFieldIds: string[];
  /** Run chain, most-recent first. */
  runChain: string[];
  /** Per-field criterion definitions for criterion_def. */
  criteriaById: Map<string, CriterionFromSkill>;
  /** Judge attribution by `${patient_id}::${field_id}`. */
  judgeByCell: Map<string, { classification_hint?: string; reasoning?: string }>;
  /** When set, a disagreement EXAMPLE is emitted only for patients in this set
   *  (the S3 refine set). gold_by_field + n_validated_patients are unaffected —
   *  they span the full validated corpus. Absent = no filter. */
  examplePatientFilter?: Set<string>;
}

export interface BuildClustersOutput {
  n_validated_patients: number;
  clusters: RefinementCluster[];
  /** Per-field reviewer gold across all validated patients (see
   *  RefinementCandidates.gold_by_field). */
  gold_by_field: Record<string, Record<string, unknown>>;
}

/**
 * Pure-ish core: walk validated review_states under sessionDir, join each
 * leaf field's human gold to the most-recent agent draft answer, capture
 * mismatches with reviewer evidence + judge attribution, and cluster by
 * field_id. No env reads, no listing of iters — everything is injected.
 */
export function buildClusters(input: BuildClustersInput): BuildClustersOutput {
  const {
    sessionDir, runsDir, taskId, leafFieldIds, runChain, criteriaById, judgeByCell,
    examplePatientFilter,
  } = input;
  const leafSet = new Set(leafFieldIds);

  // field_id → examples
  const clustered = new Map<string, RefinementExample[]>();
  const validatedPatients = new Set<string>();
  // field_id → patient_id → reviewer gold (ALL validated patients, for the S3
  // held-out re-score — not just disagreement patients).
  const goldByField: Record<string, Record<string, unknown>> = {};

  if (!fs.existsSync(sessionDir)) {
    return { n_validated_patients: 0, clusters: [], gold_by_field: {} };
  }

  for (const pid of fs.readdirSync(sessionDir)) {
    if (pid.startsWith(".")) continue;
    const state = readJson<ReviewState>(
      path.join(sessionDir, pid, taskId, "review_state.json"),
    );
    if (!state) continue;
    if (state.review_status !== "reviewer_validated") continue;

    // Human gold for each human-decided leaf field, plus its reviewer evidence.
    const humanFinal: Record<string, unknown> = {};
    const humanFA: Record<string, FieldAssessment> = {};
    for (const fa of state.field_assessments ?? []) {
      if (!leafSet.has(fa.field_id)) continue; // leaf only (skip derived)
      if (!isHumanDecided(fa)) continue;
      humanFinal[fa.field_id] = fa.answer;
      humanFA[fa.field_id] = fa;
    }
    const decidedFields = Object.keys(humanFinal);
    if (decidedFields.length === 0) continue;

    // This patient counts as a validated patient (it has ≥1 human-decided leaf
    // field) regardless of whether any agent draft exists — mirrors the intent
    // of computePerformance counting validated patients, but here we count the
    // denominator of the refine corpus.
    validatedPatients.add(pid);

    // Record gold for every human-decided leaf field on this validated patient
    // (the S3 held-out re-score needs gold for held-out patients, which aren't
    // all in the disagreement clusters). This happens for EVERY validated
    // patient, including held-out ones — only the example emission below is
    // filtered.
    for (const fid of decidedFields) {
      (goldByField[fid] ??= {})[pid] = humanFinal[fid];
    }

    // Anti-leakage (S3): if a refine-set filter is supplied, skip emitting
    // disagreement examples for held-out patients so the refiner never sees
    // them. (gold + the validated-patient count above are intentionally NOT
    // filtered — the held-out re-score depends on held-out gold.)
    if (examplePatientFilter && !examplePatientFilter.has(pid)) continue;

    // Agent answers, most-recent run wins. Mirrors computePerformance: the
    // imported run (if any) is appended to the chain as the lowest priority.
    const chain = state.imported_from_run
      ? [...runChain, state.imported_from_run]
      : runChain;
    // agentId -> fieldId -> answer (only the first/newest occurrence kept)
    const agentFieldAns: Record<string, Record<string, unknown>> = {};
    const filled = new Set<string>(); // `${agentId}::${fid}` already taken by a newer run
    for (const run of chain) {
      const agentsDir = path.join(runsDir, run, "per_patient", pid, "agents");
      if (!fs.existsSync(agentsDir)) continue;
      for (const file of fs.readdirSync(agentsDir)) {
        // Skip transcripts and B1 failure markers — a failed agent produced no
        // draft and must not appear.
        if (
          !file.endsWith(".json") ||
          file.endsWith(".error.json") ||
          file.endsWith("_transcript.jsonl")
        ) {
          continue;
        }
        const agentId = file.replace(/\.json$/, "");
        const draft = readJson<{ field_assessments?: FieldAssessment[] }>(
          path.join(agentsDir, file),
        );
        if (!draft) continue;
        for (const fa of draft.field_assessments ?? []) {
          if (!decidedFields.includes(fa.field_id)) continue;
          const key = `${agentId}::${fa.field_id}`;
          if (filled.has(key)) continue; // a newer run already supplied this field
          filled.add(key);
          (agentFieldAns[agentId] ??= {})[fa.field_id] = fa.answer;
        }
      }
    }

    // Emit one example per (agent, field) MISMATCH.
    for (const [agentId, fieldAns] of Object.entries(agentFieldAns)) {
      for (const fid of decidedFields) {
        if (!(fid in fieldAns)) continue; // this agent never answered this field
        if (answersEqual(fieldAns[fid], humanFinal[fid])) continue; // agreement
        // Mismatch.
        const ev = firstNoteEvidence(humanFA[fid]);
        const judged = judgeByCell.get(`${pid}::${fid}`);
        const hint = collapseHint(judged?.classification_hint);
        (clustered.get(fid) ?? clustered.set(fid, []).get(fid)!).push({
          patient_id: pid,
          agent_id: agentId,
          note_id: ev.note_id,
          excerpt: ev.excerpt,
          offsets: ev.offsets,
          agent_answer: fieldAns[fid],
          reviewer_answer: humanFinal[fid],
          classification_hint: judged ? hint : "unjudged",
          judge_reasoning: judged?.reasoning ?? null,
        });
      }
    }
  }

  // Build clusters in a stable, leaf-rubric order then any extras.
  const clusters: RefinementCluster[] = [];
  const orderedFieldIds = [
    ...leafFieldIds.filter((f) => clustered.has(f)),
    ...[...clustered.keys()].filter((f) => !leafSet.has(f)).sort(),
  ];
  for (const fid of orderedFieldIds) {
    const examples = clustered.get(fid)!;
    // Stable order within a cluster: by patient_id then agent_id.
    examples.sort((a, b) =>
      a.patient_id !== b.patient_id
        ? a.patient_id.localeCompare(b.patient_id)
        : a.agent_id.localeCompare(b.agent_id),
    );
    clusters.push({
      field_id: fid,
      criterion_def: criterionDef(criteriaById.get(fid)),
      answer_enum: answerEnum(criteriaById.get(fid)),
      examples,
      n_guideline_gap: examples.filter((e) => e.classification_hint === "guideline_gap").length,
      n_true_ambiguity: examples.filter((e) => e.classification_hint === "true_ambiguity").length,
      n_agent_error: examples.filter((e) => e.classification_hint === "agent_error").length,
      n_unjudged: examples.filter((e) => e.classification_hint === "unjudged").length,
    });
  }

  return { n_validated_patients: validatedPatients.size, clusters, gold_by_field: goldByField };
}

// ── Disk-wired entry point ─────────────────────────────────────────────────────

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}
function runsRootDir(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(PLATFORM_ROOT, "var", "runs");
}

/**
 * Collect the attributed, clustered agent-vs-human disagreement set for a
 * validated phenotype iter. Reads from disk via the same env-overridable roots
 * computePerformance uses. Gates on phenotype task_kind: NER/adherence return
 * an `unsupported` marker with empty clusters (later increments).
 */
export function collectRefinementCandidates(opts: CollectOpts): RefinementCandidates {
  const { sessionId, taskId, iterId, examplePatientFilter } = opts;

  const task = loadCompiledTask(taskId);
  const taskKind = task?.task_kind ?? "phenotype";
  if (taskKind !== "phenotype") {
    return {
      task_id: taskId,
      iter_id: iterId,
      session_id: sessionId,
      n_validated_patients: 0,
      clusters: [],
      gold_by_field: {},
      unsupported: {
        task_kind: taskKind,
        reason: `self-refinement S1 supports phenotype tasks only; ${taskKind} is a later increment`,
      },
    };
  }

  // Leaf criteria only (derived fields are computed downstream and can't be
  // refined). Mirrors judge-batch's leaf filter.
  const criteria = loadCriteria(taskId);
  const criteriaById = new Map<string, CriterionFromSkill>();
  const leafFieldIds: string[] = [];
  for (const c of criteria) {
    criteriaById.set(c.field_id, c);
    if (!c.derivation) leafFieldIds.push(c.field_id);
  }

  // Judge attribution from the iter's judge_analyses.json, keyed by cell.
  const judgeByCell = new Map<string, { classification_hint?: string; reasoning?: string }>();
  const ja = readJudgeAnalyses(taskId, iterId);
  if (ja && !("task_kind" in ja && (ja as { task_kind?: string }).task_kind === "ner")) {
    for (const rec of ja.analyses ?? []) {
      // Only cell-shaped (phenotype) records carry field_id; span records don't.
      const fieldId = (rec as { field_id?: string }).field_id;
      const analysis = (rec as { analysis?: { classification_hint?: string; reasoning?: string } })
        .analysis;
      if (!fieldId || !analysis) continue;
      judgeByCell.set(`${rec.patient_id}::${fieldId}`, {
        classification_hint: analysis.classification_hint,
        reasoning: analysis.reasoning,
      });
    }
  }

  const runChain = runChainForIter(taskId, sessionId, iterId);

  const { n_validated_patients, clusters, gold_by_field } = buildClusters({
    sessionDir: path.join(reviewsRoot(), sessionId),
    runsDir: runsRootDir(),
    taskId,
    leafFieldIds,
    runChain,
    criteriaById,
    judgeByCell,
    examplePatientFilter,
  });

  return {
    task_id: taskId,
    iter_id: iterId,
    session_id: sessionId,
    n_validated_patients,
    clusters,
    gold_by_field,
  };
}
