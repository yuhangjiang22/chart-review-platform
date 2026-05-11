/**
 * deployment-kappa.ts — Phase G.4
 *
 * Computes the publishable deployment-stage Cohen's kappa by comparing each
 * agent's draft answer against the reviewer's blind validation, per criterion.
 *
 * Outputs:
 *   cohorts/<cohort_id>/reports/<run_id>/deployment-kappa.json
 *   cohorts/<cohort_id>/reports/<run_id>/deployment-kappa.md
 *
 * Reading strategy for agent drafts (defensive):
 *   1. Try runs/<run_id>/per_patient/<pid>/agents/agent_1.json (multi-agent path)
 *   2. Fall back to runs/<run_id>/per_patient/<pid>/agent_draft.json (legacy)
 *
 * Reviewer answers come from:
 *   cohorts/<cohort_id>/sample/validations/<pid>/<task_id>/review_state.json
 */

import fs from "fs";
import path from "path";
import { cohortsRoot, getCohortManifest, readSelection } from "./domain/cohort/index.js";
import { getRunManifest, runsRoot } from "./infra/batch-run/index.js";
import type { FieldAssessment } from "./disagreements.js";
import { loadCriteria } from "./domain/rubric/index.js";
import { replayReviewerAnswers, computeKappaProper } from "./kappa.js";
import { PLATFORM_ROOT } from "./patients.js";
import { writeFileAtomic, writeJsonAtomic } from "./lib/fs-atomic.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A criterion's measurement type, used to dispatch the right reliability metric. */
export type CriterionType = "categorical" | "numeric";

export interface PerCriterionKappa {
  metric_type: "kappa";
  field_id: string;
  kappa: number;
  ci_lower: number;
  ci_upper: number;
  n: number;
  n_categories: number;
  /** Counts of each answer value in agent answers for this criterion. */
  agent_distribution: Record<string, number>;
  /** Counts of each answer value in reviewer answers for this criterion. */
  reviewer_distribution: Record<string, number>;
  /**
   * Inter-rater κ from the calibration phase (between human reviewers on
   * locked review_state files). Absent when fewer than 2 reviewers have
   * shared records on this field — calibration κ then isn't computable.
   */
  calibration_kappa?: number;
  /**
   * calibration_kappa - kappa (deployment). Positive ⇒ deployment trended
   * worse than calibration; negative ⇒ deployment trended better. Absent
   * when calibration_kappa is absent.
   */
  kappa_gap?: number;
}

/** When |kappa_gap| exceeds this, the markdown report flags a ⚠ next to the
 *  field — the methodologist should investigate why deployment diverged from
 *  calibration. Default 0.10 follows the convention that a 0.10 swing in κ
 *  crosses Landis & Koch buckets (e.g. substantial → moderate). */
export const KAPPA_GAP_WARN_THRESHOLD = 0.1;

export interface PerCriterionExactMatch {
  metric_type: "exact_match";
  field_id: string;
  /** n_match / n_total, in [0, 1]. */
  rate: number;
  n_match: number;
  n_total: number;
}

export type PerCriterionMetric = PerCriterionKappa | PerCriterionExactMatch;

export interface DeploymentKappaResult {
  cohort_id: string;
  run_id: string;
  /** Number of patients that had both an agent draft and a reviewer answer. */
  n_validated_patients: number;
  /** Total patients in the sample selection. */
  n_total_sampled: number;
  /**
   * N-weighted average of per-criterion kappas (kappa-type criteria only).
   * Numeric criteria contribute to per_criterion as exact_match entries but
   * are not folded into this number — the units don't compose.
   */
  overall_kappa: number;
  /** 95% CI for the overall kappa (computed from the weighted-average se). */
  overall_ci: [number, number];
  per_criterion: PerCriterionMetric[];
  computed_at: string;
}

// ---------------------------------------------------------------------------
// CI computation
// ---------------------------------------------------------------------------

/**
 * Standard error approximation for Cohen's kappa.
 *
 *   se(kappa) ~= sqrt(P_o * (1 - P_o) / (n * (1 - P_e)^2))
 *
 * where P_o = observed agreement, P_e = expected agreement under independence.
 *
 * NOTE: This closed-form approximation is the standard reported value in
 * clinical research literature (Fleiss, Levin & Paik 2003). It degrades for
 * very small n (< 30) or extreme kappa values (kappa near 0 or 1), where
 * bootstrap CIs would be more accurate. Bootstrap is not used here to keep
 * the computation deterministic and lightweight; the limitation should be
 * disclosed in the methods section.
 */
function computeKappaCi(
  kappa: number,
  po: number,
  pe: number,
  n: number,
): [number, number] {
  const denom = 1 - pe;
  if (n <= 0 || denom === 0) return [kappa, kappa];
  const se = Math.sqrt((po * (1 - po)) / (n * denom * denom));
  const margin = 1.96 * se;
  return [
    Math.max(-1, kappa - margin),
    Math.min(1, kappa + margin),
  ];
}

// ---------------------------------------------------------------------------
// Low-level kappa from paired arrays (not relying on kappa.ts which expects a
// different data shape — reviewer-vs-reviewer from chat logs)
// ---------------------------------------------------------------------------

interface KappaFromPairsResult {
  kappa: number;
  ci_lower: number;
  ci_upper: number;
  n: number;
  n_categories: number;
  agent_distribution: Record<string, number>;
  reviewer_distribution: Record<string, number>;
}

function kappaFromPairs(
  agentAnswers: string[],
  reviewerAnswers: string[],
): KappaFromPairsResult {
  const n = agentAnswers.length;
  if (n === 0) {
    return {
      kappa: NaN,
      ci_lower: NaN,
      ci_upper: NaN,
      n: 0,
      n_categories: 0,
      agent_distribution: {},
      reviewer_distribution: {},
    };
  }

  const agentDist: Record<string, number> = {};
  const reviewerDist: Record<string, number> = {};
  let agrees = 0;

  for (let i = 0; i < n; i++) {
    const a = agentAnswers[i];
    const r = reviewerAnswers[i];
    agentDist[a] = (agentDist[a] ?? 0) + 1;
    reviewerDist[r] = (reviewerDist[r] ?? 0) + 1;
    if (a === r) agrees++;
  }

  const po = agrees / n;

  // Expected agreement under independence
  const cats = new Set([...Object.keys(agentDist), ...Object.keys(reviewerDist)]);
  let pe = 0;
  for (const c of cats) {
    pe += ((agentDist[c] ?? 0) / n) * ((reviewerDist[c] ?? 0) / n);
  }

  const denom = 1 - pe;
  const kappa = denom === 0 ? 1.0 : (po - pe) / denom;
  const [ci_lower, ci_upper] = computeKappaCi(kappa, po, pe, n);

  return {
    kappa,
    ci_lower,
    ci_upper,
    n,
    n_categories: cats.size,
    agent_distribution: agentDist,
    reviewer_distribution: reviewerDist,
  };
}

// ---------------------------------------------------------------------------
// Calibration κ — from locked review_state files (inter-rater agreement)
// ---------------------------------------------------------------------------

/**
 * Compute per-field calibration κ using the same replay+kappa pipeline as the
 * bundle-export statistics. Returns a Map<field_id, κ> for fields where κ is
 * computable (≥2 reviewers, ≥10 shared records); absent fields had too few
 * reviewer pairs.
 *
 * The κ here is plain Cohen's κ (unweighted) so the value is directly
 * comparable to the deployment-κ in PerCriterionKappa.kappa, which is also
 * unweighted.
 *
 * Note: this does not currently filter by guideline_sha. It uses lifetime
 * reviewer history per field — same convention as bundle-export's per-field
 * statistics. If the rubric's structural definition of a field hasn't
 * changed between rubric versions, lifetime κ is a fair calibration baseline.
 */
function computeCalibrationKappaPerField(
  taskId: string,
  fieldIds: string[],
): Map<string, number> {
  const reviewsRootPath =
    process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
  const out = new Map<string, number>();
  if (!fs.existsSync(reviewsRootPath)) return out;
  for (const fid of fieldIds) {
    const replayed = replayReviewerAnswers(reviewsRootPath, taskId, fid);
    if (replayed.length === 0) continue;
    const k = computeKappaProper(replayed); // unweighted; matches deployment-κ semantics
    if (!k || !isFinite(k.kappa)) continue;
    out.set(fid, k.kappa);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Criterion-type detection
// ---------------------------------------------------------------------------

/**
 * Inspect a criterion's `answer_schema` and decide which reliability metric
 * applies. The rule is intentionally simple: if the schema declares `type`
 * containing `"number"`, treat the field as numeric (exact-match metric).
 * Everything else — enums, strings, booleans — is categorical (Cohen's kappa).
 */
export function inferCriterionType(answerSchema: unknown): CriterionType {
  if (!answerSchema || typeof answerSchema !== "object") return "categorical";
  const t = (answerSchema as Record<string, unknown>).type;
  if (t === "number") return "numeric";
  if (Array.isArray(t) && t.includes("number")) return "numeric";
  return "categorical";
}

/**
 * Build a Map<field_id, CriterionType> for the given task. Uses the phenotype
 * skill loader (with legacy YAML fallback). Fields not present in the rubric
 * default to categorical when looked up.
 */
export function loadCriterionTypes(taskId: string): Map<string, CriterionType> {
  const out = new Map<string, CriterionType>();
  try {
    const criteria = loadCriteria(taskId);
    for (const c of criteria) {
      out.set(c.field_id, inferCriterionType(c.answer_schema));
    }
  } catch {
    // If the rubric can't be loaded, fall back to "everything is categorical"
    // — kappa computation still runs; just no exact-match dispatch.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exact-match metric (numeric criteria)
// ---------------------------------------------------------------------------

/**
 * Compute exact-match rate for paired numeric answers. Both null is a match
 * (reviewer and agent agreed "no value in window"). One null and one number
 * is a mismatch. Two numbers are compared for strict equality after coercion
 * to Number — chart-extracted lab values are typically integers or one-decimal
 * floats, so floating-point fuzz isn't a real concern here.
 */
function exactMatchFromPairs(
  agentAnswers: unknown[],
  reviewerAnswers: unknown[],
): { rate: number; n_match: number; n_total: number } {
  const n = agentAnswers.length;
  if (n === 0) return { rate: NaN, n_match: 0, n_total: 0 };

  let matches = 0;
  for (let i = 0; i < n; i++) {
    const a = agentAnswers[i];
    const r = reviewerAnswers[i];
    const aNull = a === null || a === undefined;
    const rNull = r === null || r === undefined;
    if (aNull && rNull) {
      matches++;
    } else if (aNull || rNull) {
      // one null, one not — mismatch
    } else if (Number(a) === Number(r)) {
      matches++;
    }
  }
  return { rate: matches / n, n_match: matches, n_total: n };
}

// ---------------------------------------------------------------------------
// Answer normalization (mirrors disagreements.ts logic)
// ---------------------------------------------------------------------------

function normalizeAnswer(a: unknown): string {
  if (a === null || a === undefined) return "no_info";
  if (typeof a === "boolean") return a ? "true" : "false";
  if (typeof a === "number") return String(a);
  if (typeof a === "string") {
    const s = a.trim().toLowerCase();
    if (s === "" || s === "null" || s === "undefined" || s === "n/a" || s === "unknown") return "no_info";
    return s;
  }
  return String(a);
}

// ---------------------------------------------------------------------------
// Reading agent drafts (defensive)
// ---------------------------------------------------------------------------

interface RawDraft {
  field_assessments: FieldAssessment[];
}

function readAgentDraft(runId: string, patientId: string): RawDraft | null {
  const runs = runsRoot();

  // Drafts live at runs/<run_id>/per_patient/<pid>/agents/<agent_id>.json.
  // Single-agent runs use agent_1.json; dual-agent runs add agent_2.json etc.
  // Older runs used a flat agent_draft.json file at the per-patient root —
  // that path is no longer supported; old runs from before the dual-agent
  // refactor have been deleted.
  const draftPath = path.join(runs, runId, "per_patient", patientId, "agents", "agent_1.json");
  if (fs.existsSync(draftPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(draftPath, "utf8"));
      if (Array.isArray(raw.field_assessments)) return raw as RawDraft;
    } catch { /* fall through */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reading reviewer validation state
// ---------------------------------------------------------------------------

interface RawReviewState {
  field_assessments?: FieldAssessment[];
}

/**
 * Read the validation state for a single sampled patient. Two on-disk shapes
 * are supported, in this priority order:
 *
 * 1. **Multi-reviewer** —
 *      cohorts/<id>/sample/validations/<pid>/<task>/<reviewer_id>/review_state.json
 *    Each reviewer scores the same patient independently (blinded). Consensus
 *    per field is computed via majority vote across reviewers; ties drop the
 *    field from the κ computation rather than guessing a winner. Used when
 *    the sample is double-or-triple-coded for higher-confidence ground truth.
 *
 * 2. **Single-reviewer** (the original layout) —
 *      cohorts/<id>/sample/validations/<pid>/<task>/review_state.json
 *    One reviewer per patient; this is what the smoke test and existing
 *    cohort plan workflow produce. Stays the default for backward compat.
 *
 * Multi-reviewer wins when both exist — that's the more recent / more rigorous
 * artifact, and a leftover single-reviewer file shouldn't downgrade the
 * consensus.
 */
function readReviewerState(cohortId: string, patientId: string, taskId: string): RawReviewState | null {
  const taskDir = path.join(cohortsRoot(), cohortId, "sample", "validations", patientId, taskId);

  // 1. Multi-reviewer: each <reviewer_id>/review_state.json contributes one vote.
  if (fs.existsSync(taskDir)) {
    const perReviewerStates: RawReviewState[] = [];
    for (const entry of fs.readdirSync(taskDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Skip directory names that look like reserved/hidden.
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const rsPath = path.join(taskDir, entry.name, "review_state.json");
      if (!fs.existsSync(rsPath)) continue;
      try {
        perReviewerStates.push(JSON.parse(fs.readFileSync(rsPath, "utf8")) as RawReviewState);
      } catch {
        // skip unreadable
      }
    }
    if (perReviewerStates.length > 0) {
      return collapseToConsensus(perReviewerStates);
    }
  }

  // 2. Single-reviewer fallback.
  const p = path.join(taskDir, "review_state.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as RawReviewState;
  } catch {
    return null;
  }
}

/**
 * Collapse N per-reviewer review_states into one synthetic state by majority
 * vote per field. Fields with no clear majority (a tie among ≥2 distinct
 * answers) are dropped — comparing the agent against an "ambiguous" reviewer
 * answer would just inject noise. Ties have to be adjudicated externally
 * before consensus κ becomes meaningful.
 *
 * Vote keys are produced by normalizeAnswer so booleans, capitalization, and
 * Python-style nulls coalesce — same conventions used everywhere else in the
 * deployment-κ pipeline.
 */
function collapseToConsensus(perReviewerStates: RawReviewState[]): RawReviewState {
  // field_id -> normalized vote string -> { count, sample_assessment }
  const votes = new Map<string, Map<string, { count: number; sample: FieldAssessment }>>();

  for (const rs of perReviewerStates) {
    for (const fa of rs.field_assessments ?? []) {
      const fid = fa.field_id;
      const key = normalizeAnswer(fa.answer);
      let bucket = votes.get(fid);
      if (!bucket) {
        bucket = new Map();
        votes.set(fid, bucket);
      }
      const existing = bucket.get(key);
      if (existing) existing.count++;
      else bucket.set(key, { count: 1, sample: fa });
    }
  }

  const consensus: FieldAssessment[] = [];
  for (const [, bucket] of votes) {
    let best: { count: number; sample: FieldAssessment } | null = null;
    let tie = false;
    for (const v of bucket.values()) {
      if (!best || v.count > best.count) {
        best = v;
        tie = false;
      } else if (v.count === best.count) {
        tie = true;
      }
    }
    if (best && !tie) consensus.push(best.sample);
    // tie ⇒ drop field; the calling κ code will treat it as "reviewer didn't
    // record a stable answer" and skip the pair.
  }

  return { field_assessments: consensus };
}

// ---------------------------------------------------------------------------
// Report paths
// ---------------------------------------------------------------------------

export function reportDir(cohortId: string, runId: string): string {
  return path.join(cohortsRoot(), cohortId, "reports", runId);
}

export function reportJsonPath(cohortId: string, runId: string): string {
  return path.join(reportDir(cohortId, runId), "deployment-kappa.json");
}

export function reportMdPath(cohortId: string, runId: string): string {
  return path.join(reportDir(cohortId, runId), "deployment-kappa.md");
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function generateMarkdown(result: DeploymentKappaResult, cohortId: string, guidelineSha: string): string {
  const nTotal = result.n_total_sampled;
  const nValid = result.n_validated_patients;

  const rows = result.per_criterion
    .map((c) => {
      if (c.metric_type === "kappa") {
        const kStr = isFinite(c.kappa) ? c.kappa.toFixed(2) : "N/A";
        const ciStr = isFinite(c.ci_lower) && isFinite(c.ci_upper)
          ? `(${c.ci_lower.toFixed(2)}, ${c.ci_upper.toFixed(2)})`
          : "N/A";
        let calibCol = "—";
        if (c.calibration_kappa !== undefined && c.kappa_gap !== undefined) {
          const warn = Math.abs(c.kappa_gap) > KAPPA_GAP_WARN_THRESHOLD ? " ⚠" : "";
          const sign = c.kappa_gap >= 0 ? "+" : "";
          calibCol = `${c.calibration_kappa.toFixed(2)} (Δ ${sign}${c.kappa_gap.toFixed(2)})${warn}`;
        }
        return `| ${c.field_id} | kappa | ${kStr} | ${ciStr} | ${c.n} | ${calibCol} |`;
      } else {
        const rateStr = isFinite(c.rate) ? `${(c.rate * 100).toFixed(0)}%` : "N/A";
        return `| ${c.field_id} | exact match | ${rateStr} (${c.n_match}/${c.n_total}) | — | ${c.n_total} | — |`;
      }
    })
    .join("\n");

  const flagged = result.per_criterion.filter(
    (c) =>
      c.metric_type === "kappa" &&
      c.kappa_gap !== undefined &&
      Math.abs(c.kappa_gap) > KAPPA_GAP_WARN_THRESHOLD,
  );

  const overallK = isFinite(result.overall_kappa) ? result.overall_kappa.toFixed(2) : "N/A";
  const [lo, hi] = result.overall_ci;
  const overallCi = isFinite(lo) && isFinite(hi)
    ? `${lo.toFixed(2)}-${hi.toFixed(2)}`
    : "N/A";

  const hasNumeric = result.per_criterion.some((c) => c.metric_type === "exact_match");

  return `## Deployment-stage agent-vs-reviewer agreement

We applied the locked rubric (sha \`${guidelineSha}\`) to cohort \`${cohortId}\`.
We drew a stratified sample of N=${nTotal} patients for blinded reviewer validation.
Reviewers blinded to agent output independently scored each criterion using the locked rubric.
${nValid < nTotal ? `\nNote: only ${nValid} of ${nTotal} sampled patients have completed reviewer validation; this is an intermediate report.\n` : ""}
Deployment-stage agent-vs-reviewer agreement (Cohen's kappa for categorical criteria, exact-match rate for numeric criteria). The "calibration κ" column shows inter-rater κ from the locked review_state files at this task; Δ is calibration κ minus deployment κ. ⚠ marks fields where |Δ| > ${KAPPA_GAP_WARN_THRESHOLD.toFixed(2)} — investigate.

| Criterion | metric | value | 95% CI | n | calibration κ (Δ) |
|---|---|---|---|---|---|
${rows}

Overall: kappa = ${overallK} (95% CI: ${overallCi}) — averaged over categorical criteria only.${hasNumeric ? " Numeric criteria are reported per-row above; their units don't compose with kappa." : ""}
${flagged.length > 0 ? `\n⚠ ${flagged.length} criteri${flagged.length === 1 ? "on" : "a"} flagged with |Δ| > ${KAPPA_GAP_WARN_THRESHOLD.toFixed(2)}: ${flagged.map((c) => c.field_id).join(", ")}. Real-world charts may have surfaced edge cases the calibration cohort missed; review these per-field distributions and consider promoting via the deployment-issues queue.\n` : ""}

The 95% confidence intervals use the closed-form standard error approximation
(se(kappa) ~= sqrt(P_o * (1 - P_o) / (n * (1 - P_e)^2))), which is the
standard reported value in clinical research. For small samples (n < 30) or
extreme kappa values, bootstrap CIs are more accurate.
`;
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

/**
 * Compute the deployment-stage kappa for a cohort run.
 *
 * Steps:
 *  1. Load the cohort manifest and the sample selection for this run.
 *  2. For each selected patient, load the agent draft and reviewer state.
 *  3. For each field_id that appears in agent drafts, collect (agent, reviewer)
 *     answer pairs from all patients that have both.
 *  4. Compute per-criterion kappa + 95% CI.
 *  5. Compute overall kappa as n-weighted average.
 *
 * Throws if:
 *  - cohort not found
 *  - run not found or does not belong to this cohort
 *  - no sample selection exists for this run
 */
export function computeDeploymentKappa(cohortId: string, runId: string): DeploymentKappaResult {
  const cohortManifest = getCohortManifest(cohortId);
  if (!cohortManifest) throw new Error(`cohort "${cohortId}" not found`);

  const runManifest = getRunManifest(runId);
  if (!runManifest) throw new Error(`run "${runId}" not found`);
  if (runManifest.cohort_id !== cohortId) {
    throw new Error(`run "${runId}" does not belong to cohort "${cohortId}"`);
  }

  const selection = readSelection(cohortId, runId);
  if (!selection) throw new Error(`no sample selection found for run "${runId}" in cohort "${cohortId}"`);

  const selectedPatients = selection.selected;
  const taskId = cohortManifest.task_id;

  const criterionTypes = loadCriterionTypes(taskId);
  const typeOf = (fid: string): CriterionType => criterionTypes.get(fid) ?? "categorical";

  // Collect raw (agent, reviewer) answer pairs per field_id. We keep the raw
  // values (including nulls) and let the per-metric computation decide how to
  // handle them — categorical fields drop pairs where either side is null,
  // numeric fields treat both-null as a match.
  const pairsByField = new Map<string, { agent: unknown[]; reviewer: unknown[] }>();

  let patientsWithBoth = 0;

  for (const pid of selectedPatients) {
    const agentDraft = readAgentDraft(runId, pid);
    const reviewerState = readReviewerState(cohortId, pid, taskId);

    if (!agentDraft || !reviewerState) continue;

    // Index reviewer assessments by field_id (last one wins for duplicates).
    // For numeric fields we want to keep null/undefined answers as data points
    // (both-null is a valid match). For categorical fields the null filter is
    // applied later, when the pair is materialized.
    const reviewerByField = new Map<string, FieldAssessment>();
    for (const fa of (reviewerState.field_assessments ?? [])) {
      reviewerByField.set(fa.field_id, fa);
    }

    let hadAnyPair = false;
    for (const agentFa of agentDraft.field_assessments) {
      const reviewerFa = reviewerByField.get(agentFa.field_id);
      if (!reviewerFa) continue; // reviewer hasn't recorded this criterion at all

      const fieldType = typeOf(agentFa.field_id);
      // For categorical, drop pairs where reviewer didn't answer (null).
      // For numeric, keep them — both-null is meaningful agreement.
      if (fieldType === "categorical" && (reviewerFa.answer === undefined || reviewerFa.answer === null)) {
        continue;
      }

      const bucket = pairsByField.get(agentFa.field_id) ?? { agent: [], reviewer: [] };
      bucket.agent.push(agentFa.answer);
      bucket.reviewer.push(reviewerFa.answer);
      pairsByField.set(agentFa.field_id, bucket);
      hadAnyPair = true;
    }

    if (hadAnyPair) patientsWithBoth++;
  }

  // Compute calibration κ once for all kappa-type fields, then attach to each
  // per-criterion entry below.
  const kappaFieldIds: string[] = [];
  for (const fieldId of pairsByField.keys()) {
    if (typeOf(fieldId) !== "numeric") kappaFieldIds.push(fieldId);
  }
  const calibrationKappa = kappaFieldIds.length > 0
    ? computeCalibrationKappaPerField(taskId, kappaFieldIds)
    : new Map<string, number>();

  // Compute per-criterion metrics, dispatched by type.
  const perCriterion: PerCriterionMetric[] = [];
  for (const [fieldId, pairs] of pairsByField.entries()) {
    if (typeOf(fieldId) === "numeric") {
      const r = exactMatchFromPairs(pairs.agent, pairs.reviewer);
      perCriterion.push({
        metric_type: "exact_match",
        field_id: fieldId,
        rate: r.rate,
        n_match: r.n_match,
        n_total: r.n_total,
      });
    } else {
      const normalizedAgent = pairs.agent.map(normalizeAnswer);
      const normalizedReviewer = pairs.reviewer.map(normalizeAnswer);
      const r = kappaFromPairs(normalizedAgent, normalizedReviewer);
      const calibK = calibrationKappa.get(fieldId);
      const entry: PerCriterionKappa = {
        metric_type: "kappa",
        field_id: fieldId,
        kappa: r.kappa,
        ci_lower: r.ci_lower,
        ci_upper: r.ci_upper,
        n: r.n,
        n_categories: r.n_categories,
        agent_distribution: r.agent_distribution,
        reviewer_distribution: r.reviewer_distribution,
      };
      if (calibK !== undefined && isFinite(r.kappa)) {
        entry.calibration_kappa = calibK;
        entry.kappa_gap = calibK - r.kappa;
      }
      perCriterion.push(entry);
    }
  }

  // Sort for stable output (deterministic field order).
  perCriterion.sort((a, b) => a.field_id.localeCompare(b.field_id));

  // Overall kappa: n-weighted average over kappa-type criteria only.
  // Numeric criteria contribute exact-match entries but the units don't compose.
  let totalN = 0;
  let weightedKappaSum = 0;
  let weightedSeSquaredSum = 0;

  for (const c of perCriterion) {
    if (c.metric_type !== "kappa") continue;
    if (!isFinite(c.kappa) || c.n === 0) continue;
    totalN += c.n;
    weightedKappaSum += c.kappa * c.n;
    // Propagate variance: var_overall ~= sum(n_i^2 * var_i) / totalN^2
    // We use (ci_upper - ci_lower) / (2 * 1.96) to recover se_i.
    const se_i = isFinite(c.ci_upper) && isFinite(c.ci_lower)
      ? (c.ci_upper - c.ci_lower) / (2 * 1.96)
      : 0;
    weightedSeSquaredSum += (c.n * c.n) * (se_i * se_i);
  }

  let overallKappa = NaN;
  let overallCi: [number, number] = [NaN, NaN];
  if (totalN > 0) {
    overallKappa = weightedKappaSum / totalN;
    const overallSe = Math.sqrt(weightedSeSquaredSum) / totalN;
    const margin = 1.96 * overallSe;
    overallCi = [
      Math.max(-1, overallKappa - margin),
      Math.min(1, overallKappa + margin),
    ];
  }

  return {
    cohort_id: cohortId,
    run_id: runId,
    n_validated_patients: patientsWithBoth,
    n_total_sampled: selectedPatients.length,
    overall_kappa: overallKappa,
    overall_ci: overallCi,
    per_criterion: perCriterion,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Compute deployment kappa and persist both JSON + Markdown reports to disk.
 *
 * Writes to:
 *   cohorts/<cohort_id>/reports/<run_id>/deployment-kappa.json
 *   cohorts/<cohort_id>/reports/<run_id>/deployment-kappa.md
 */
export function computeAndPersistDeploymentKappa(cohortId: string, runId: string): DeploymentKappaResult {
  const result = computeDeploymentKappa(cohortId, runId);

  const cohortManifest = getCohortManifest(cohortId)!;
  const dir = reportDir(cohortId, runId);
  fs.mkdirSync(dir, { recursive: true });

  writeJsonAtomic(reportJsonPath(cohortId, runId), result);
  writeFileAtomic(
    reportMdPath(cohortId, runId),
    generateMarkdown(result, cohortId, cohortManifest.guideline_sha),
  );

  return result;
}

/**
 * Load a persisted deployment-kappa report, or return null if none exists.
 */
export function loadPersistedReport(cohortId: string, runId: string): DeploymentKappaResult | null {
  const p = reportJsonPath(cohortId, runId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as DeploymentKappaResult;
  } catch {
    return null;
  }
}
