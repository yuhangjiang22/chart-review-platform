/**
 * Pilot iterations — the "draft → run on N patients → human validates →
 * refine guideline → re-run" loop that precedes scaling to a full cohort.
 *
 * A pilot iteration is conceptually a *tagged batch run* with extra
 * lifecycle state that doesn't belong in the run manifest itself:
 *
 *   - the iteration number for this guideline (sequential per task)
 *   - the methodologist's notes (added after seeing validations)
 *   - explicit "complete" / "abandoned" markers
 *   - eventually: post-validation summary metrics (kappa per field,
 *     override rate) once #11 follow-ups land
 *
 * Layout:
 *
 *   guidelines/<task_id>/pilots/
 *     iter_001/manifest.json
 *     iter_002/manifest.json
 *     ...
 *
 * The actual agent draft outputs live in `runs/<run_id>/per_patient/...`
 * (see `runs.ts`) — pilots/<iter>/manifest.json carries `run_id` so the
 * UI can drill through to the existing RunDetail surface.
 */

import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { guidelineDir, loadCriteria, phenotypeSkillDir } from "@chart-review/rubric";
import { computeTaskSha } from "@chart-review/lock";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { startBatchRun, getRunStatus, getRunManifest, runDir, agentDraftPath, type RunStatus } from "@chart-review/infra-batch-run";
import { loadCompiledTask } from "@chart-review/tasks";
import { improveGuideline, type ImproveGuidelineResult } from "@chart-review/domain-proposal";
import type { AgentSpec } from "@chart-review/agent-specs";
import { compareDrafts, loadAgentDrafts, type AgentDraft, type Disagreement, type DisagreementSummary, type FieldAssessment } from "@chart-review/disagreements";
import { atomicWriteJson } from "@chart-review/storage";
import { listAdjudications, splitByClassification, writeAgentErrors, type Adjudication } from "@chart-review/adjudications";
import {
  criterionSchemaHashFromFile,
  criterionSchemaHash,
  computeRerunPlan,
  type RerunPlan,
} from "@chart-review/criterion-hash";
import type { ProviderName } from "@chart-review/agent-provider";
import { getSessionManifest } from "./sessions.js";

/** The session's rubric version label ({based_on, active_version}) to snapshot
 *  onto a new iter, or undefined for session-less / legacy sessions. */
function sessionRubricLabel(
  taskId: string,
  sessionId: string | undefined,
): PilotManifest["rubric"] {
  if (!sessionId) return undefined;
  return getSessionManifest(taskId, sessionId)?.rubric;
}

export type PilotState =
  | "running"
  | "ready_to_validate"
  | "complete"
  | "abandoned"
  /** Phase-driven workspace additions (Plan B). Old manifests never contain
   *  these values; only new writes use them. */
  | "validating"   // reviewer has committed ≥1 cell; still in progress
  | "revising"     // revise endpoint called; next version being assembled
  | "superseded"   // a child version was created from this one
  | "locked";      // terminal lock; methods bundle shippable

export function isValidatingState(s: PilotState): s is "validating" {
  return s === "validating";
}
export function isRevisingState(s: PilotState): s is "revising" {
  return s === "revising";
}
export function isSupersededState(s: PilotState): s is "superseded" {
  return s === "superseded";
}
export function isLockedVersionState(s: PilotState): s is "locked" {
  return s === "locked";
}

/**
 * Canonical lifecycle phase of a Pilot Iter — one value, one source of truth
 * for "what state is this Iter in?". See docs/CONTEXT.md for the full
 * definition. Today this is computed from the existing scattered fields
 * (`state`, `auto_critique_state`, `run_status`); future commits in the
 * R2 phase will migrate writers to set `phase` directly so it becomes
 * canonical on disk.
 *
 *   running              — the batch run is actively executing
 *   awaiting_validation  — agent done, methodologist reviewing/adjudicating
 *   critiquing           — auto-critique computing proposals
 *   complete             — terminal: critique done (with or without proposals)
 *   failed               — terminal: batch run errored
 *   abandoned            — terminal: methodologist marked irrelevant
 */
export type IterPhase =
  | "running"
  | "awaiting_validation"
  | "critiquing"
  | "complete"
  | "failed"
  | "abandoned";

/**
 * Derive the canonical phase from the today-scattered fields. This function
 * is the single source of truth for the mapping; the UI and any analytics
 * code should call this rather than switching on `state` + `auto_critique_state`
 * + `run_status` independently.
 */
export function derivePhase(
  m: Pick<PilotManifest, "state" | "auto_critique_state">,
  runStatus: RunStatus["state"] | null,
): IterPhase {
  if (m.state === "abandoned") return "abandoned";
  if (m.state === "complete") {
    if (m.auto_critique_state === "running") return "critiquing";
    return "complete";
  }
  if (m.state === "ready_to_validate") return "awaiting_validation";
  // state === "running"
  if (runStatus === "failed" || runStatus === "complete_with_errors") return "failed";
  return "running";
}

/**
 * Discrete actions the methodologist (or the server, for auto-critique) can
 * take on an Iter to advance its phase. Every post-creation mutation of an
 * Iter manifest's lifecycle fields goes through `transitionPhase`, so the
 * mapping from action → state mutation lives in one place.
 *
 * Iter creation (the very first transition into "running") happens in
 * `startPilotIteration`; that's a constructor, not a transition, so it
 * isn't part of this union.
 */
export type IterAction =
  | { type: "set_state"; state: PilotState; notes?: string }
  | { type: "begin_auto_critique" }
  | { type: "complete_auto_critique" }
  | { type: "fail_auto_critique" };

/**
 * Pure transition: given a manifest + an action, return the new manifest.
 * No I/O. The writers (`setPilotState`, `fireAutoCritique`) wrap this with
 * the disk write so the on-disk schema and the in-memory mutation can't
 * drift.
 *
 * The mapping:
 *   set_state              → write `state` (and `completed_at` for terminal states; `notes` if provided)
 *   begin_auto_critique    → set auto_critique_state="running"
 *   complete_auto_critique → delete auto_critique_state (success)
 *   fail_auto_critique     → set auto_critique_state="failed"
 *
 * Throws if the action would produce an unrepresentable manifest (e.g.
 * begin_auto_critique on an Iter that's not yet in `complete`). Today the
 * production code already guards these preconditions at the call site —
 * the throws here are defense in depth.
 */
export function transitionPhase(m: PilotManifest, action: IterAction): PilotManifest {
  switch (action.type) {
    case "set_state": {
      const next: PilotManifest = {
        ...m,
        state: action.state,
        ...(action.notes !== undefined ? { notes: action.notes } : {}),
        ...(action.state === "complete" ||
            action.state === "abandoned" ||
            action.state === "superseded" ||
            action.state === "locked"
          ? { completed_at: new Date().toISOString() }
          : {}),
      };
      return next;
    }
    case "begin_auto_critique": {
      // Auto-critique only makes sense from a `complete` Iter. Earlier states
      // already have running / awaiting_validation / abandoned semantics.
      if (m.state !== "complete") {
        throw new Error(
          `cannot begin_auto_critique from state=${m.state}; expected "complete"`,
        );
      }
      return { ...m, auto_critique_state: "running" };
    }
    case "complete_auto_critique": {
      const { auto_critique_state: _drop, ...rest } = m;
      void _drop;
      return rest;
    }
    case "fail_auto_critique": {
      return { ...m, auto_critique_state: "failed" };
    }
  }
}

export interface PilotManifest {
  task_id: string;
  iter_id: string;        // "iter_001", "iter_002", ...
  iter_num: number;       // 1, 2, ... (parsed from iter_id)
  /** Session this iter belongs to. Absent on pre-session iters; the
   *  reader treats absent as the synthetic LEGACY_SESSION_ID so legacy
   *  iters keep showing up under a stable header. */
  session_id?: string;
  run_id: string;         // the batch-run that produced the drafts
  guideline_sha: string;  // SHA of the guideline at iteration start
  /** Human-readable rubric version this iter ran on, snapshotted from the
   *  session at iter start (e.g. {based_on:"v1", active_version:"s1"}). The
   *  guideline_sha is the precise content identity; this is the friendly label
   *  the UI shows. Snapshotted (not derived live) so the label stays correct
   *  even if the session later switches versions. Absent on legacy iters and
   *  session-less runs. */
  rubric?: { based_on: string; active_version: string };
  started_at: string;
  started_by: string;
  state: PilotState;
  notes?: string;
  completed_at?: string;
  /** #42 — set when the methodologist marks this pilot complete and the
   *  server kicks off selfCritiquePilot in the background. The UI uses this
   *  to show "auto-critiquing..." while the critique.json is being written.
   *  Cleared (deleted) once the critique record lands. */
  auto_critique_state?: "running" | "failed";
  agent_specs?: AgentSpec[];
  /** Criterion-level rerun — populated at iter start.
   *  Maps each leaf criterion field_id to its schema_hash at the time
   *  the iteration started. Used to diff against the next iteration. */
  criterion_schema_hashes?: Record<string, string>;
  /** Criterion-level rerun — computed from diffing against the prior iter's
   *  criterion_schema_hashes. Present on every iter; whole-guideline reruns
   *  have carried_criteria=[] and rerun_criteria=<all>. */
  rerun_plan?: RerunPlan;
}

/**
 * Alias for PilotManifest — new code uses GuidelineVersion.
 * PilotManifest remains valid for back-compat; both names refer to the
 * same shape. When the filesystem migration (Plan C) lands, this alias
 * will be replaced by a full rename; call sites using GuidelineVersion
 * will need no further edits.
 */
export type GuidelineVersion = PilotManifest;

export interface PilotListing extends PilotManifest {
  /** Pulled live from runs/<run_id>/status.json. Null if the run was deleted. */
  run_status: RunStatus["state"] | null;
  /** Canonical lifecycle phase, derived from manifest + run_status. The UI
   *  consumes this; analytics consumes this. Don't switch on the underlying
   *  fields directly — use `phase`. */
  phase: IterPhase;
  n_complete: number;
  n_patients: number;
  /** Agent provider that produced this iter's draft, sourced from the run
   *  manifest. Absent for pre-v0.7.1 runs that didn't record a provider —
   *  consumers should display "(server default)" in that case. */
  provider?: ProviderName;
  /** Latest self-critique record (#12) for this iteration, if any. */
  critique?: {
    ran_at: string;
    proposal_count: number;
    error?: string;
    accuracy?: Record<string, unknown> | null;
  } | null;
  /** Refinement-loop addition: per-iter accuracy summary, populated when
   *  the iter's critique.json contains an `accuracy` block. */
  accuracy_summary?: {
    worst: { field_id: string; accuracy: number } | null;
    avg: number | null;
    override_count: number;
  } | null;
}

/**
 * Primary = reviewer-emitted criterion (no `derivation` field).
 *
 * Reads criteria from the skill-format directory at
 * `.claude/skills/chart-review-<taskId>/references/criteria/` via
 * `loadCriteria`. Returns an empty array when no criteria exist.
 */
export function readPrimaryCriterionIds(taskId: string): string[] {
  const criteria = loadCriteria(taskId);
  return criteria
    .filter((c) => c.derivation == null)
    .map((c) => c.field_id)
    .sort();
}

function pilotsDir(taskId: string): string {
  return path.join(guidelineDir(taskId), "pilots");
}

export function pilotIterDir(taskId: string, iterId: string): string {
  return path.join(pilotsDir(taskId), iterId);
}

function pilotManifestPath(taskId: string, iterId: string): string {
  return path.join(pilotIterDir(taskId, iterId), "manifest.json");
}

function nextIterId(taskId: string): { iter_id: string; iter_num: number } {
  const dir = pilotsDir(taskId);
  let next = 1;
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const m = /^iter_(\d+)$/.exec(name);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= next) next = n + 1;
      }
    }
  }
  const iterId = `iter_${String(next).padStart(3, "0")}`;
  return { iter_id: iterId, iter_num: next };
}

// ── criterion hash snapshot helpers ─────────────────────────────────────────

/**
 * Build the { [field_id]: schema_hash } snapshot for all leaf criteria of a task.
 *
 * Prefers the skill-format directory; falls back to legacy YAML criteria dir.
 * Returns an empty map if neither exists (first-run safety valve).
 */
export function snapshotCriterionHashesSync(taskId: string): Record<string, string> {
  // Try skill-format first.
  const skillCriteriaDir = path.join(phenotypeSkillDir(taskId), "references", "criteria");
  if (fs.existsSync(skillCriteriaDir)) {
    const out: Record<string, string> = {};
    for (const filename of fs.readdirSync(skillCriteriaDir).sort()) {
      if (!filename.endsWith(".md")) continue;
      const filepath = path.join(skillCriteriaDir, filename);
      const h = criterionSchemaHashFromFile(filepath);
      if (h === null) continue;
      const field_id = filename.replace(/\.md$/, "");
      out[field_id] = h;
    }
    return out;
  }

  // Fallback: legacy criteria directory under the skill dir.
  // After the guidelines→skill migration, criteria YAML files (if any) live
  // at guidelineDir(taskId)/criteria/. For fully-migrated tasks this directory
  // won't contain YAML, so this path returns {} — the caller falls back to a
  // whole-guideline rerun, which is the correct safe default.
  const legacyCriteriaDir = path.join(guidelineDir(taskId), "criteria");
  if (!fs.existsSync(legacyCriteriaDir)) return {};

  const out: Record<string, string> = {};
  for (const filename of fs.readdirSync(legacyCriteriaDir).sort()) {
    if (!filename.endsWith(".yaml") && !filename.endsWith(".yml")) continue;
    const filepath = path.join(legacyCriteriaDir, filename);
    let doc: Record<string, unknown>;
    try {
      doc = (parseYaml(fs.readFileSync(filepath, "utf8")) ?? {}) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (doc.derivation != null) continue;
    const field_id = (doc.id as string | undefined) ?? filename.replace(/\.ya?ml$/, "");
    out[field_id] = criterionSchemaHash(doc);
  }
  return out;
}

/**
 * Return the most recent prior pilot iteration manifest for a task, or null
 * if this is the first iteration.
 */
function getPriorPilotManifest(taskId: string, currentIterNum: number): PilotManifest | null {
  if (currentIterNum <= 1) return null;
  const dir = pilotsDir(taskId);
  if (!fs.existsSync(dir)) return null;
  // Walk backwards from currentIterNum-1 to find the most recent prior iter.
  for (let n = currentIterNum - 1; n >= 1; n--) {
    const iterId = `iter_${String(n).padStart(3, "0")}`;
    const m = getPilotManifest(taskId, iterId);
    if (m) return m;
  }
  return null;
}

// ── read helpers ─────────────────────────────────────────────────────────────

export function getPilotManifest(taskId: string, iterId: string): PilotManifest | null {
  const p = pilotManifestPath(taskId, iterId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as PilotManifest;
  } catch {
    return null;
  }
}

export function listPilotIterations(taskId: string): PilotListing[] {
  const dir = pilotsDir(taskId);
  if (!fs.existsSync(dir)) return [];
  const out: PilotListing[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/^iter_\d+$/.test(name)) continue;
    const m = getPilotManifest(taskId, name);
    if (!m) continue;
    const status = getRunStatus(m.run_id);
    const runManifest = getRunManifest(m.run_id);
    const critique = getPilotCritique(taskId, m.iter_id);
    let accuracy_summary: PilotListing["accuracy_summary"] = null;
    const critiqueAccuracy = (critique as any)?.accuracy;
    if (critiqueAccuracy) {
      accuracy_summary = {
        worst: critiqueAccuracy.worst_accuracy ?? null,
        avg: critiqueAccuracy.avg_accuracy ?? null,
        override_count: critiqueAccuracy.override_count ?? 0,
      };
    }
    const runStatusValue = status?.state ?? null;
    out.push({
      ...m,
      run_status: runStatusValue,
      phase: derivePhase(m, runStatusValue),
      n_complete: status?.n_complete ?? 0,
      n_patients: status?.n_patients ?? 0,
      ...(runManifest?.provider ? { provider: runManifest.provider } : {}),
      critique: critique
        ? {
            ran_at: critique.ran_at,
            proposal_count: critique.proposal_count,
            error: critique.error,
            accuracy: (critique as any).accuracy ?? null,
          }
        : null,
      accuracy_summary,
    });
  }
  return out.sort((a, b) => b.iter_num - a.iter_num);
}

// ── driver ───────────────────────────────────────────────────────────────────

export interface StartPilotOptions {
  task_id: string;
  patient_ids: string[];
  started_by: string;
  notes?: string;
  max_concurrency?: number;
  max_turns_per_patient?: number;
  cost_cap_usd?: number;
  /** Optional callback for run status updates — passed through to startBatchRun. */
  onRunStatus?: (s: RunStatus) => void;
  agent_specs?: AgentSpec[];
  /** Per-run override of the AGENT_PROVIDER env var. */
  provider?: ProviderName;
  /** Per-run model override — wins over CHART_REVIEW_MODEL env var.
   *  Stamped onto every agent_spec that doesn't carry its own model. */
  model?: string;
  /** Session this iter is being started under. When set, the iter's
   *  manifest carries this session_id and the platform's session-aware
   *  views (sidebar, switcher, scoped phase panes) will associate the
   *  iter with the session. Absent = legacy ungrouped iter. */
  session_id?: string;
  per_note?: boolean;
}

export interface StartPilotResult {
  pilot: PilotManifest;
}

/**
 * Kick off a new pilot iteration. Picks the next sequential iter number,
 * starts a batch-run, writes the pilot manifest, and returns immediately
 * (the run continues in the background — see startBatchRun).
 *
 * As part of starting the iteration, this function:
 *  1. Snapshots the current criterion schema hashes into the manifest.
 *  2. Computes a rerun_plan by diffing against the prior iteration's hashes.
 *  3. Passes target_field_ids to startBatchRun so the agent only answers
 *     criteria that changed (criterion-focused mode). When all criteria need
 *     rerunning (first iter or legacy prior iter), behavior is identical to
 *     the existing whole-guideline mode.
 *  4. After the run completes, merges partial drafts with prior iter's drafts
 *     for carried criteria (draft merging — Step 4).
 *  5. Carries forward adjudications for unchanged criteria (Step 5) — this
 *     happens in the auto-critique path via carryForwardAdjudications().
 */
export function startPilotIteration(opts: StartPilotOptions): StartPilotResult {
  if (!opts.patient_ids || opts.patient_ids.length === 0) {
    throw new Error("patient_ids must be non-empty");
  }
  const guidelineSha = computeTaskSha(guidelineDir(opts.task_id));
  const { iter_id, iter_num } = nextIterId(opts.task_id);

  // Step 3: snapshot criterion hashes and compute rerun plan.
  let criterionSchemaHashes: Record<string, string> = {};
  let rerunPlan: RerunPlan = { carried_criteria: [], rerun_criteria: [] };
  try {
    criterionSchemaHashes = snapshotCriterionHashesSync(opts.task_id);
    const priorManifest = getPriorPilotManifest(opts.task_id, iter_num);
    rerunPlan = computeRerunPlan(criterionSchemaHashes, priorManifest);

    // Guardrail (a): a DERIVED field (one carrying a `derivation`) must never
    // be a focused-rerun target. It is recomputed from its leaf inputs after
    // each leaf write, not answered by the agent. If only its definition
    // changed, computeRerunPlan would otherwise make it the sole rerun target
    // and the agent would answer it directly with no leaf inputs. Move any
    // derived field out of rerun_criteria into carried_criteria.
    const derivedFieldIds = new Set(
      (loadCompiledTask(opts.task_id)?.fields ?? [])
        .filter((f) => f.derivation)
        .map((f) => f.id),
    );
    if (derivedFieldIds.size > 0 && rerunPlan.rerun_criteria.some((f) => derivedFieldIds.has(f))) {
      rerunPlan = {
        ...rerunPlan,
        rerun_criteria: rerunPlan.rerun_criteria.filter((f) => !derivedFieldIds.has(f)).sort(),
        carried_criteria: [
          ...rerunPlan.carried_criteria,
          ...rerunPlan.rerun_criteria.filter((f) => derivedFieldIds.has(f)),
        ].sort(),
      };
    }

    // Guardrail (b): focused-rerun carry-forward only works for patients that
    // have a prior draft to carry. A patient appearing for the first time in
    // this cohort/session has nothing to carry, so its carried criteria would
    // render blank (only the re-run criterion gets answered). If ANY cohort
    // patient lacks a prior draft in the carry source, fall back to a whole-
    // guideline run so every criterion is answered for every patient.
    if (rerunPlan.carried_criteria.length > 0 && rerunPlan.rerun_criteria.length > 0) {
      const priorRunId = priorManifest?.run_id;
      const priorSpecs = priorManifest?.agent_specs ?? [{ id: "agent_1" }];
      const everyPatientCarryable =
        !!priorRunId &&
        opts.patient_ids.every((pid) =>
          priorSpecs.some((s) => fs.existsSync(agentDraftPath(priorRunId, pid, s.id))),
        );
      if (!everyPatientCarryable) {
        rerunPlan = { carried_criteria: [], rerun_criteria: Object.keys(criterionSchemaHashes) };
      }
    }
  } catch (e) {
    // Hash computation is non-fatal — fall back to whole-guideline rerun.
    console.warn(`[pilots] criterion hash snapshot failed for ${opts.task_id}/${iter_id}: ${(e as Error).message}`);
    rerunPlan = {
      carried_criteria: [],
      rerun_criteria: Object.keys(criterionSchemaHashes),
    };
  }

  // Determine target_field_ids for the agent invocation.
  // When all criteria need rerunning (or hash snapshot failed), pass undefined
  // so the agent runs in whole-guideline mode (unchanged behavior).
  const isFocusedRerun =
    rerunPlan.carried_criteria.length > 0 && rerunPlan.rerun_criteria.length > 0;
  const targetFieldIds = isFocusedRerun ? rerunPlan.rerun_criteria : undefined;

  // Stamp the per-run model onto agent_specs that don't already pin one.
  // Per-spec models still win (the methodologist can set
  // {id:"agent_1", model:"sonnet"} and our default doesn't overwrite it).
  const stampedSpecs = opts.model && opts.agent_specs
    ? opts.agent_specs.map((s) => ({ ...s, model: s.model ?? opts.model }))
    : opts.agent_specs;

  const { run_id } = startBatchRun({
    task_id: opts.task_id,
    patient_ids: opts.patient_ids,
    started_by: opts.started_by,
    label: `pilot-${iter_id}`,
    max_concurrency: opts.max_concurrency,
    max_turns_per_patient: opts.max_turns_per_patient,
    cost_cap_usd: opts.cost_cap_usd,
    agent_specs: stampedSpecs,
    target_field_ids: targetFieldIds,
    provider: opts.provider,
    session_id: opts.session_id,
    per_note: opts.per_note,
    onStatus: opts.onRunStatus,
  });

  const manifest: PilotManifest = {
    task_id: opts.task_id,
    iter_id,
    iter_num,
    session_id: opts.session_id,
    run_id,
    guideline_sha: guidelineSha,
    rubric: sessionRubricLabel(opts.task_id, opts.session_id),
    started_at: new Date().toISOString(),
    started_by: opts.started_by,
    state: "running",
    notes: opts.notes,
    agent_specs: opts.agent_specs,
    criterion_schema_hashes: Object.keys(criterionSchemaHashes).length > 0
      ? criterionSchemaHashes
      : undefined,
    rerun_plan: rerunPlan,
  };
  atomicWriteJson(pilotManifestPath(opts.task_id, iter_id), manifest);
  return { pilot: manifest };
}

// ── import an existing run as an iter ─────────────────────────────────────────

export interface ImportPilotOptions {
  task_id: string;
  /** The existing batch run to adopt (its drafts already live under
   *  runs/<run_id>/per_patient/...). Typically produced by the headless
   *  deploy-runner, but any run for this task works. */
  run_id: string;
  started_by: string;
  /** Session this imported iter belongs to. Set by the session-create
   *  import path so VALIDATE/Performance scope to the right session. */
  session_id?: string;
  notes?: string;
}

/**
 * Adopt an EXISTING batch run as a new pilot iteration instead of starting a
 * fresh agent run. This is the "import" half of TRY's run-or-import choice:
 * a run produced headlessly by the deploy-runner writes the same on-disk
 * layout (runs/<run_id>/per_patient/<pid>/agents/<agent>.json) that the in-UI
 * run button produces, so all this has to do is write a pilot manifest that
 * points VALIDATE/Performance at those drafts — no agent work is re-run.
 *
 * The run's own `guideline_sha` and `agent_specs` are carried onto the iter so
 * cross-iter comparability and the Performance pane behave exactly as they do
 * for an in-UI run.
 */
export function importPilotIteration(opts: ImportPilotOptions): StartPilotResult {
  const runManifest = getRunManifest(opts.run_id);
  if (!runManifest) {
    throw new Error(`run not found: ${opts.run_id}`);
  }
  if (runManifest.task_id !== opts.task_id) {
    throw new Error(
      `run ${opts.run_id} belongs to task "${runManifest.task_id}", not "${opts.task_id}" — `
      + "import a run produced for this task.",
    );
  }
  const { iter_id, iter_num } = nextIterId(opts.task_id);
  // A finished run is ready to validate; a still-running one stays "running"
  // and the normal auto-advance-on-run-complete path promotes it later.
  const runStatus = getRunStatus(opts.run_id);
  const state: PilotState =
    runStatus && runStatus.state === "running" ? "running" : "ready_to_validate";

  const manifest: PilotManifest = {
    task_id: opts.task_id,
    iter_id,
    iter_num,
    session_id: opts.session_id,
    run_id: opts.run_id,
    guideline_sha:
      runManifest.guideline_sha || computeTaskSha(guidelineDir(opts.task_id)),
    rubric: sessionRubricLabel(opts.task_id, opts.session_id),
    started_at: new Date().toISOString(),
    started_by: opts.started_by,
    state,
    notes: opts.notes ?? `Imported existing run ${opts.run_id}`,
    agent_specs: runManifest.agent_specs,
  };
  atomicWriteJson(pilotManifestPath(opts.task_id, iter_id), manifest);
  return { pilot: manifest };
}

// ── self-critique (#12) ──────────────────────────────────────────────────────

export interface PilotCritiqueRecord {
  task_id: string;
  iter_id: string;
  ran_at: string;
  ran_by: string;
  patients_analyzed: string[];
  proposal_count: number;
  proposals: Array<{ proposal_id: string; path: string }>;
  duration_ms: number;
  cost_usd?: number;
  error?: string;
}

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

function pilotCritiquePath(taskId: string, iterId: string): string {
  return path.join(pilotIterDir(taskId, iterId), "critique.json");
}

export function getPilotCritique(taskId: string, iterId: string): PilotCritiqueRecord | null {
  const p = pilotCritiquePath(taskId, iterId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as PilotCritiqueRecord;
  } catch {
    return null;
  }
}

/**
 * Run the self-critique on a pilot iteration. Reads the pilot's run to
 * find which patients were drafted, filters to those whose review_state
 * .json now exists (i.e. drafts were imported and possibly edited by a
 * human), and calls `improveGuideline` to cluster reviewer overrides
 * into structured rule proposals.
 *
 * The proposals enter the standard rule-store (visible in RulesPanel /
 * MethodologistView). A small critique.json is persisted next to the
 * pilot manifest so the PilotsPanel can show "N proposals" without
 * re-running.
 */
export async function selfCritiquePilot(opts: {
  task_id: string;
  iter_id: string;
  ran_by: string;
  focus_criterion?: string;
}): Promise<PilotCritiqueRecord> {
  const startedAt = Date.now();
  const pilot = getPilotManifest(opts.task_id, opts.iter_id);
  if (!pilot) throw new Error(`pilot iteration not found: ${opts.task_id}/${opts.iter_id}`);
  const runManifest = getRunManifest(pilot.run_id);
  if (!runManifest) throw new Error(`run not found for pilot: ${pilot.run_id}`);

  // Filter to patients whose review_state.json exists (was imported).
  const patientsWithState = runManifest.patient_ids.filter((pid) =>
    fs.existsSync(path.join(reviewsRoot(), pid, opts.task_id, "review_state.json")),
  );

  // Locate proposals_seed.json (emitted by emitDerivedArtifactsOnCompletion).
  const seedPath = path.join(pilotIterDir(opts.task_id, opts.iter_id), "proposals_seed.json");
  const seedExists = fs.existsSync(seedPath);
  let seedHasGaps = false;
  if (seedExists) {
    try {
      const seed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as { guideline_gaps?: unknown[] };
      seedHasGaps = Array.isArray(seed.guideline_gaps) && seed.guideline_gaps.length > 0;
    } catch { /* ignore parse errors */ }
  }

  // Bail only if BOTH sources of signal are absent.
  if (patientsWithState.length === 0 && !seedHasGaps) {
    const rec: PilotCritiqueRecord = {
      task_id: opts.task_id,
      iter_id: opts.iter_id,
      ran_at: new Date().toISOString(),
      ran_by: opts.ran_by,
      patients_analyzed: [],
      proposal_count: 0,
      proposals: [],
      duration_ms: Date.now() - startedAt,
      error: "no review_state.json files and no guideline-gap adjudications — nothing to cluster",
    };
    atomicWriteJson(pilotCritiquePath(opts.task_id, opts.iter_id), rec);
    return rec;
  }

  let result: ImproveGuidelineResult;
  try {
    result = await improveGuideline({
      guideline_id: opts.task_id,
      patient_ids: patientsWithState,  // may be empty; that's OK if seedHasGaps is true
      focus_criterion: opts.focus_criterion,
      proposals_seed_file: seedExists ? seedPath : undefined,
    });
  } catch (e) {
    const rec: PilotCritiqueRecord = {
      task_id: opts.task_id,
      iter_id: opts.iter_id,
      ran_at: new Date().toISOString(),
      ran_by: opts.ran_by,
      patients_analyzed: patientsWithState,
      proposal_count: 0,
      proposals: [],
      duration_ms: Date.now() - startedAt,
      error: (e as Error).message,
    };
    atomicWriteJson(pilotCritiquePath(opts.task_id, opts.iter_id), rec);
    return rec;
  }

  const rec: PilotCritiqueRecord = {
    task_id: opts.task_id,
    iter_id: opts.iter_id,
    ran_at: new Date().toISOString(),
    ran_by: opts.ran_by,
    patients_analyzed: result.patients_analyzed,
    proposal_count: result.proposal_count,
    proposals: result.proposals.map((p) => ({ proposal_id: p.proposal_id, path: p.path })),
    duration_ms: Date.now() - startedAt,
    cost_usd: result.cost_usd,
    error: result.error,
  };
  atomicWriteJson(pilotCritiquePath(opts.task_id, opts.iter_id), rec);
  return rec;
}

// ── disagreement extraction (Task 4.2) ──────────────────────────────────────

export function extractDisagreements(taskId: string, iterId: string): DisagreementSummary {
  const m = getPilotManifest(taskId, iterId);
  if (!m) throw new Error(`pilot ${iterId} not found`);
  const rd = runDir(m.run_id);
  const status = getRunStatus(m.run_id);
  const patientIds = status?.per_patient ? Object.keys(status.per_patient) : [];

  const allPairs: Array<{ agent_a: string; agent_b: string }> = [];
  const allDisagreements: Disagreement[] = [];
  let totalSameAnswerDiff = 0;
  const byCriterion: DisagreementSummary["by_criterion"] = {};
  const seenPair = new Set<string>();

  for (const pid of patientIds) {
    const drafts = loadAgentDrafts(rd, pid);
    if (drafts.length < 2) continue;
    const summary = compareDrafts(drafts);
    // Dedupe pair labels — pairs are the same across patients
    for (const p of summary.pairs_compared) {
      const key = `${p.agent_a}__${p.agent_b}`;
      if (!seenPair.has(key)) {
        seenPair.add(key);
        allPairs.push(p);
      }
    }
    allDisagreements.push(...summary.disagreements);
    totalSameAnswerDiff += summary.same_answer_different_evidence_count;
    for (const [fid, counts] of Object.entries(summary.by_criterion)) {
      const e = byCriterion[fid] ?? { disagreement_count: 0, hard_count: 0, soft_count: 0 };
      e.disagreement_count += counts.disagreement_count;
      e.hard_count += counts.hard_count;
      e.soft_count += counts.soft_count;
      byCriterion[fid] = e;
    }
  }

  return {
    pairs_compared: allPairs,
    disagreements: allDisagreements,
    same_answer_different_evidence_count: totalSameAnswerDiff,
    by_criterion: byCriterion,
  };
}

export function writePilotDisagreements(taskId: string, iterId: string): string {
  const summary = extractDisagreements(taskId, iterId);
  const fp = path.join(pilotIterDir(taskId, iterId), "disagreements.json");
  atomicWriteJson(fp, summary);
  return fp;
}

// ── draft merging (Step 4) ────────────────────────────────────────────────────

/**
 * Merge a partial agent draft (from a focused rerun covering only rerun_criteria)
 * with the prior iteration's full draft, producing a complete merged draft.
 *
 * - For each field_id in `rerunCriteria`: use the entry from `newDraft` (if present),
 *   tagged with `provenance.iter: currentIterId`.
 * - For each field_id in `carriedCriteria`: use the entry from `priorDraft` (if present),
 *   tagged with `provenance.iter: priorIterId`.
 * - Any field present in `priorDraft` but not in either list is left as-is.
 *
 * Returns the merged field_assessments array.
 */
export function mergeDraftFieldAssessments(opts: {
  priorDraft: { field_assessments?: FieldAssessment[] };
  newDraft: { field_assessments?: FieldAssessment[] };
  rerunCriteria: string[];
  carriedCriteria: string[];
  currentIterId: string;
  priorIterId: string;
}): FieldAssessment[] {
  const { priorDraft, newDraft, rerunCriteria, carriedCriteria, currentIterId, priorIterId } = opts;
  const rerunSet = new Set(rerunCriteria);
  const carriedSet = new Set(carriedCriteria);

  // Index assessments by field_id.
  const newByField = new Map<string, FieldAssessment>(
    (newDraft.field_assessments ?? []).map((fa) => [fa.field_id, fa]),
  );
  const priorByField = new Map<string, FieldAssessment>(
    (priorDraft.field_assessments ?? []).map((fa) => [fa.field_id, fa]),
  );

  const merged: FieldAssessment[] = [];

  // Add rerun criteria from new draft (with current iter provenance).
  for (const fid of rerunCriteria) {
    const fa = newByField.get(fid);
    if (fa) {
      merged.push({ ...fa, provenance: { iter: currentIterId } });
    }
    // If the agent didn't emit an answer for this field (error/skip), we skip it
    // (the field will be absent from the merged draft — caller handles as needed).
  }

  // Add carried criteria from prior draft (with prior iter provenance).
  for (const fid of carriedCriteria) {
    const fa = priorByField.get(fid);
    if (fa) {
      merged.push({ ...fa, provenance: { iter: priorIterId } });
    }
  }

  // Add any fields in the prior draft that are not in rerun or carried sets
  // (e.g., derived fields not tracked in criterion_schema_hashes). Keep as-is.
  for (const [fid, fa] of priorByField) {
    if (!rerunSet.has(fid) && !carriedSet.has(fid)) {
      merged.push(fa);
    }
  }

  return merged;
}

/**
 * After a focused-rerun completes, merge the new partial drafts with the prior
 * iteration's full drafts for all (patient, agent) cells.
 *
 * Only runs when:
 *  - The current pilot has a rerun_plan with at least one carried criterion.
 *  - A prior iteration exists with a run_id we can read drafts from.
 *  - The prior iteration's run has draft files.
 *
 * Skips patients/agents where prior drafts are missing (falls back to
 * whatever the new run produced — typically a whole-guideline draft for
 * new patients).
 *
 * This function is a no-op (safe to call always) when there is nothing to merge.
 */
export function mergePilotDrafts(taskId: string, iterId: string): void {
  const manifest = getPilotManifest(taskId, iterId);
  if (!manifest) return;
  const { rerun_plan, run_id } = manifest;
  if (!rerun_plan || rerun_plan.carried_criteria.length === 0) return; // whole-guideline rerun, nothing to merge

  const priorIterId = rerun_plan.carried_from;
  if (!priorIterId) return;
  const priorManifest = getPilotManifest(taskId, priorIterId);
  if (!priorManifest) return;
  const priorRunId = priorManifest.run_id;

  const currentRunManifest = getRunManifest(run_id);
  if (!currentRunManifest) return;
  const patientIds = currentRunManifest.patient_ids;
  const agentSpecs = manifest.agent_specs ?? [{ id: "agent_1" }];

  for (const pid of patientIds) {
    for (const spec of agentSpecs) {
      const agentId = spec.id;
      const newDraftPath = agentDraftPath(run_id, pid, agentId);
      const priorDraftPath = agentDraftPath(priorRunId, pid, agentId);

      if (!fs.existsSync(newDraftPath)) continue; // agent didn't produce a draft for this patient
      if (!fs.existsSync(priorDraftPath)) continue; // no prior draft — new patient, nothing to merge

      let newDraft: { field_assessments?: FieldAssessment[]; [k: string]: unknown };
      let priorDraft: { field_assessments?: FieldAssessment[]; [k: string]: unknown };
      try {
        newDraft = JSON.parse(fs.readFileSync(newDraftPath, "utf8"));
        priorDraft = JSON.parse(fs.readFileSync(priorDraftPath, "utf8"));
      } catch {
        continue; // skip on parse error
      }

      const merged = mergeDraftFieldAssessments({
        priorDraft,
        newDraft,
        rerunCriteria: rerun_plan.rerun_criteria,
        carriedCriteria: rerun_plan.carried_criteria,
        currentIterId: iterId,
        priorIterId,
      });

      // Write the merged draft back to the current run's agent draft path.
      const mergedDraft = { ...newDraft, field_assessments: merged };
      try {
        atomicWriteJson(newDraftPath, mergedDraft);
      } catch {
        // Best-effort; if it fails the original partial draft is still there.
      }
    }
  }
}

// ── adjudication carry-forward (Step 5) ──────────────────────────────────────

/**
 * Carry forward adjudications from the prior iteration for criteria whose
 * schema hash has not changed (carried_criteria in the rerun_plan).
 *
 * Adjudications for changed criteria (rerun_criteria) are dropped — the
 * reviewer must re-adjudicate after the new draft is produced.
 *
 * Each carried adjudication is tagged with `provenance.carried_from: priorIterId`.
 *
 * This function writes to the current iter's `adjudications.json` and should
 * be called BEFORE `extractDisagreements` so the carried adjudications are
 * visible alongside the new ones.
 *
 * Safe to call when there are no prior adjudications or no carried criteria
 * (returns without writing anything in those cases).
 */
export function carryForwardAdjudications(taskId: string, iterId: string): void {
  const manifest = getPilotManifest(taskId, iterId);
  if (!manifest) return;
  const { rerun_plan } = manifest;
  if (!rerun_plan || rerun_plan.carried_criteria.length === 0) return; // whole-guideline rerun

  const priorIterId = rerun_plan.carried_from;
  if (!priorIterId) return;

  const priorIterDir_ = pilotIterDir(taskId, priorIterId);
  const priorAdjs = listAdjudications(priorIterDir_);
  if (priorAdjs.length === 0) return; // nothing to carry

  const carriedSet = new Set(rerun_plan.carried_criteria);
  const currentIterDir_ = pilotIterDir(taskId, iterId);

  // Load any adjudications already written to the current iter
  // (e.g., if this function was called more than once).
  const existingAdjs = listAdjudications(currentIterDir_);
  const existingKeys = new Set(
    existingAdjs.map((a) => `${a.patient_id}__${a.field_id}__${a.pair.agent_a}__${a.pair.agent_b}`),
  );

  const toCarry: Adjudication[] = [];
  for (const adj of priorAdjs) {
    // Only carry adjudications whose field_id is in carried_criteria.
    if (!carriedSet.has(adj.field_id)) continue;
    const key = `${adj.patient_id}__${adj.field_id}__${adj.pair.agent_a}__${adj.pair.agent_b}`;
    if (existingKeys.has(key)) continue; // already present
    toCarry.push({
      ...adj,
      provenance: { carried_from: priorIterId },
    } as Adjudication & { provenance?: { carried_from: string } });
  }

  if (toCarry.length === 0) return;

  const merged = [...existingAdjs, ...toCarry];
  const fp = path.join(currentIterDir_, "adjudications.json");
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(currentIterDir_, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, fp);
}

// ── derived artifact emission (Task 5.3) ─────────────────────────────────────

/**
 * Derive `agent_errors.json` and `proposals_seed.json` from the pilot's
 * `adjudications.json` on completion. Writes to the same iter directory as
 * `disagreements.json` and `critique.json`.
 *
 * - `agent_errors.json`: adjudications classified as agent_a_error or agent_b_error
 *   (per spec §14.7, consumed by Phase 2 tooling).
 * - `proposals_seed.json`: guideline-gap adjudications in a shape ready for
 *   a future `improveGuideline` integration. For MVP, the file is written to
 *   disk but not yet threaded into `improveGuideline`'s prompt — see follow-up.
 *
 * Safe to call when there are no adjudications yet (returns early).
 */
export function emitDerivedArtifactsOnCompletion(taskId: string, iterId: string): void {
  const dir = pilotIterDir(taskId, iterId);
  const adjs = listAdjudications(dir);
  if (adjs.length === 0) return; // nothing to derive yet
  const split = splitByClassification(adjs);
  writeAgentErrors(dir, split.agent_errors);
  // Emit proposals_seed.json — the guideline-gap adjudications, in a shape
  // that improveGuideline can consume in a follow-up task. For MVP we
  // write the file but don't yet thread it into improveGuideline's prompt.
  const seedPath = path.join(dir, "proposals_seed.json");
  atomicWriteJson(seedPath, { guideline_gaps: split.guideline_gaps });
}

/**
 * #42 — fire-and-forget auto-critique. Writes `auto_critique_state: "running"`
 * to the pilot manifest, runs `selfCritiquePilot`, then clears the state (or
 * sets it to `"failed"` if critique threw). Safe to call multiple times — if
 * a critique already exists, this is a no-op.
 */
export function fireAutoCritique(
  taskId: string,
  iterId: string,
  ranBy: string,
): void {
  const existing = getPilotCritique(taskId, iterId);
  if (existing) return; // already critiqued, nothing to do
  const manifest = getPilotManifest(taskId, iterId);
  if (!manifest) return;
  if (manifest.auto_critique_state === "running") return; // already in flight

  // Mark running before kicking off the async work so concurrent callers
  // (e.g. duplicate PATCH requests) bail.
  atomicWriteJson(
    pilotManifestPath(taskId, iterId),
    transitionPhase(manifest, { type: "begin_auto_critique" }),
  );

  // Background — never blocks the HTTP response. We swallow errors after
  // logging because there's no caller to await us.
  void (async () => {
    try {
      // Step 4: Merge partial drafts with prior iter's drafts for carried criteria.
      // Only active when the iter ran in criterion-focused mode. No-op otherwise.
      try {
        mergePilotDrafts(taskId, iterId);
      } catch (me) {
        console.warn(`[auto-critique] draft merge skipped for ${taskId}/${iterId}: ${(me as Error).message}`);
      }
      // Step 5: Carry forward adjudications for unchanged criteria.
      // Must run BEFORE extractDisagreements so carried adjudications are visible.
      try {
        carryForwardAdjudications(taskId, iterId);
      } catch (ce) {
        console.warn(`[auto-critique] adjudication carry-forward skipped for ${taskId}/${iterId}: ${(ce as Error).message}`);
      }
      // Emit disagreements.json before the critique so the file is available
      // even if the critique step fails. Wrapped in try/catch so a single-agent
      // pilot (< 2 agents) doesn't block completion.
      try {
        writePilotDisagreements(taskId, iterId);
      } catch (de) {
        console.warn(`[auto-critique] disagreements skipped for ${taskId}/${iterId}: ${(de as Error).message}`);
      }
      // Emit agent_errors.json + proposals_seed.json from adjudications.json
      // (Task 5.3). Wrapped in try/catch so a pilot with zero adjudications
      // doesn't block completion.
      try {
        emitDerivedArtifactsOnCompletion(taskId, iterId);
      } catch (ae) {
        console.warn(`[auto-critique] derived artifacts skipped for ${taskId}/${iterId}: ${(ae as Error).message}`);
      }
      await selfCritiquePilot({
        task_id: taskId,
        iter_id: iterId,
        ran_by: ranBy,
      });
      // Clear the auto_critique_state on success.
      const updated = getPilotManifest(taskId, iterId);
      if (updated) {
        atomicWriteJson(
          pilotManifestPath(taskId, iterId),
          transitionPhase(updated, { type: "complete_auto_critique" }),
        );
      }
    } catch (e) {
      console.error(
        `[auto-critique] ${taskId}/${iterId} failed: ${(e as Error).message}`,
      );
      const updated = getPilotManifest(taskId, iterId);
      if (updated) {
        atomicWriteJson(
          pilotManifestPath(taskId, iterId),
          transitionPhase(updated, { type: "fail_auto_critique" }),
        );
      }
    }
  })();
}

// ── iteration compare (#37) ──────────────────────────────────────────────────

export interface PilotIterationStats {
  iter_id: string;
  iter_num: number;
  guideline_sha: string;
  state: PilotState;
  /** Total patients in the underlying batch run. */
  n_patients: number;
  /** Patients whose agent_draft completed. */
  n_complete: number;
  /** Patients whose drafts have been imported into reviews/. Counted per
   *  task kind — see {@link iterStatsRecordContribution}. */
  n_imported: number;
  /** Reviewer-override signal, summed across imported records. Per kind:
   *  phenotype counts field_assessments where source==="reviewer" + status===
   *  "overridden" OR original_agent_snapshot exists; ner counts 1 per record
   *  with reviewer activity (rejected span or validated_notes); adherence
   *  counts 1 per record with a reviewer-sourced question_answer/rule_verdict.
   *  See {@link iterStatsRecordContribution} for the rationale. */
  n_overrides: number;
  /** n_overrides / (n_imported × n_leaf_fields) — overall override rate. */
  override_rate: number;
  /** Proposal count from the iteration's self-critique, if any. */
  proposal_count: number;
  /** Total cost across the run's per-patient agent invocations. */
  total_cost_usd: number;
}

/** Minimal cross-kind view of a review_state record for stats counting. */
export interface IterStatsReviewRecord {
  /** Discriminator. Absent → treated as "phenotype" (legacy state files). */
  task_kind?: "phenotype" | "ner" | "adherence";
  lock_task_sha?: string;
  field_assessments?: Array<{
    source?: string;
    status?: string;
    original_agent_snapshot?: unknown;
  }>;
  // NER
  span_labels?: Array<{ status?: string }>;
  validated_notes?: string[];
  // Adherence
  question_answers?: Array<{ source?: string }>;
  rule_verdicts?: Array<{ source?: string }>;
}

/**
 * Per-record contribution to {n_imported, n_overrides} for one iteration's
 * SHA, branched by task kind. Pure + exported so it's unit-testable without
 * the surrounding filesystem walk.
 *
 * Kind-specific definitions (the phenotype-only assumptions did not hold for
 * the new kinds, which carry `lock_task_sha:null` and `field_assessments:[]`):
 *
 *   phenotype — UNCHANGED. `imported` gates on the record being pinned to
 *     THIS iteration's SHA; `overrides` counts reviewer field_assessments in
 *     status "overridden" OR carrying an original_agent_snapshot.
 *
 *   ner — `imported` = the record carries ≥1 span (NER review states never set
 *     lock_task_sha, so we must NOT gate on it). `overrides`: a clean
 *     span-level override signal (status==="rejected") is the ideal metric,
 *     but the live validated fixtures contain zero rejected spans (the
 *     reviewer validated every mapped span as-is), so rejected-only would
 *     read as "no review happened". We therefore count `overrides` as 1 when
 *     the reviewer showed ANY activity — either ≥1 rejected span OR any
 *     validated_notes — so a fully-validated NER iter is not misreported as
 *     untouched. Span-level override *rate* is the deferred calibration metric
 *     (eval-span-iaa), not this coarse iteration-stats counter.
 *
 *   adherence — `imported` = the record carries ≥1 question_answer or
 *     rule_verdict; `overrides` = 1 when any question_answer or rule_verdict
 *     has source==="reviewer".
 */
export function iterStatsRecordContribution(
  record: IterStatsReviewRecord,
  iterGuidelineSha: string,
): { imported: boolean; overrides: number } {
  const kind = record.task_kind ?? "phenotype";

  if (kind === "ner") {
    const spans = record.span_labels ?? [];
    if (spans.length === 0) return { imported: false, overrides: 0 };
    const rejected = spans.some((s) => s.status === "rejected");
    const reviewerActivity = rejected || (record.validated_notes ?? []).length > 0;
    return { imported: true, overrides: reviewerActivity ? 1 : 0 };
  }

  if (kind === "adherence") {
    const qas = record.question_answers ?? [];
    const rvs = record.rule_verdicts ?? [];
    if (qas.length === 0 && rvs.length === 0) return { imported: false, overrides: 0 };
    const reviewerEdit =
      qas.some((q) => q.source === "reviewer") || rvs.some((r) => r.source === "reviewer");
    return { imported: true, overrides: reviewerEdit ? 1 : 0 };
  }

  // phenotype (default) — UNCHANGED semantics.
  if (record.lock_task_sha !== iterGuidelineSha) return { imported: false, overrides: 0 };
  let overrides = 0;
  for (const fa of record.field_assessments ?? []) {
    if (fa.source === "reviewer" && (fa.status === "overridden" || fa.original_agent_snapshot)) {
      overrides++;
    }
  }
  return { imported: true, overrides };
}

/** Compute per-iteration stats for every pilot iteration of a task. */
export function pilotIterationStats(taskId: string): PilotIterationStats[] {
  const dir = pilotsDir(taskId);
  if (!fs.existsSync(dir)) return [];

  // Load the live guideline once to count leaf fields (denominator for
  // override_rate). Best-effort — if missing, treat as 1 to avoid /0.
  let nLeafFields = 1;
  try {
    const task = require("./skill-bundle.js").loadSkillBundle(taskId) as { fields?: Array<{ derivation?: unknown }> };
    nLeafFields = Math.max(1, (task.fields ?? []).filter((f) => !f.derivation).length);
  } catch { /* leave at 1 */ }

  const out: PilotIterationStats[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^iter_\d+$/.test(name)) continue;
    const m = getPilotManifest(taskId, name);
    if (!m) continue;
    const status = getRunStatus(m.run_id);
    const critique = getPilotCritique(taskId, name);

    let nImported = 0;
    let nOverrides = 0;
    let totalCost = status?.total_cost_usd ?? 0;
    const runManifestPath = path.join(
      process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(PLATFORM_ROOT, "var", "runs"),
      m.run_id,
      "manifest.json",
    );
    let patientIds: string[] = [];
    if (fs.existsSync(runManifestPath)) {
      try {
        const rm = JSON.parse(fs.readFileSync(runManifestPath, "utf8")) as { patient_ids?: string[] };
        patientIds = rm.patient_ids ?? [];
      } catch { /* skip */ }
    }
    // Review states live under the session-scoped layout
    // (<reviewsRoot>/<session_id>/<pid>/<task>/) since session isolation.
    // Pre-session iters have no session_id → fall back to the flat path.
    const reviewsBase = m.session_id
      ? path.join(reviewsRoot(), m.session_id)
      : reviewsRoot();
    for (const pid of patientIds) {
      const rsPath = path.join(reviewsBase, pid, taskId, "review_state.json");
      if (!fs.existsSync(rsPath)) continue;
      try {
        const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as IterStatsReviewRecord;
        const contrib = iterStatsRecordContribution(rs, m.guideline_sha);
        if (!contrib.imported) continue;
        nImported++;
        nOverrides += contrib.overrides;
      } catch { /* skip */ }
    }

    const denom = Math.max(1, nImported * nLeafFields);
    out.push({
      iter_id: m.iter_id,
      iter_num: m.iter_num,
      guideline_sha: m.guideline_sha,
      state: m.state,
      n_patients: status?.n_patients ?? patientIds.length,
      n_complete: status?.n_complete ?? 0,
      n_imported: nImported,
      n_overrides: nOverrides,
      override_rate: nOverrides / denom,
      proposal_count: critique?.proposal_count ?? 0,
      total_cost_usd: +totalCost.toFixed(6),
    });
  }
  return out.sort((a, b) => a.iter_num - b.iter_num);
}

/** Update the pilot's state field. Used to mark complete / abandoned, or
 *  to roll back to "ready_to_validate" once the run finishes. */
export function setPilotState(taskId: string, iterId: string, state: PilotState, notes?: string): PilotManifest {
  const m = getPilotManifest(taskId, iterId);
  if (!m) throw new Error(`pilot iteration not found: ${taskId}/${iterId}`);
  const updated = transitionPhase(m, { type: "set_state", state, notes });
  atomicWriteJson(pilotManifestPath(taskId, iterId), updated);
  return updated;
}

/**
 * Transition an iter to "revising". Called by the POST /revise endpoint
 * before it creates the child iter. Throws if the iter is locked (the one
 * hard gate per the spec) or not found.
 *
 * Plan C will add the subsequent "superseded" transition once the child
 * version's manifest is confirmed written.
 */
export function transitionIterToRevising(taskId: string, iterId: string): PilotManifest {
  const m = getPilotManifest(taskId, iterId);
  if (!m) throw new Error(`pilot iteration not found: ${taskId}/${iterId}`);
  if (m.state === "locked") {
    throw new Error(`cannot revise a locked version: ${taskId}/${iterId}`);
  }
  const updated = transitionPhase(m, { type: "set_state", state: "revising" });
  atomicWriteJson(pilotManifestPath(taskId, iterId), updated);
  return updated;
}

// Re-export so callers can import from either pilots.ts or the index.
export { maybeTransitionIterToValidating } from "./validating-transition.js";
