/**
 * Agent batch-run primitive — manifest/status types + read helpers +
 * filesystem layout. The actual driver (`startBatchRun`) lives below.
 *
 * Spec: docs/superpowers/specs/2026-05-01-agent-batch-run-design.md
 *
 * Layout:
 *   runs/<run_id>/
 *     manifest.json            # immutable run-level provenance
 *     status.json              # mutable; updated atomically as patients complete
 *     per_patient/<pid>/
 *       agent_draft.json       # review_state.json shape; lock_task_sha = manifest.guideline_sha
 *       audit.jsonl            # tool_use + assistant message events
 *       error.txt              # only if state == "error"
 *
 * `run_id` is an ISO timestamp with `:` and `.` replaced by `-`. An optional
 * `label` is recorded in manifest.json but does NOT appear in the path.
 */

import fs from "fs";
import path from "path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import type { AgentSpec } from "@chart-review/agent-specs";
import { defaultProviderName, type ProviderName } from "@chart-review/agent-provider";

export type RunState =
  | "running"
  | "complete"
  | "complete_with_errors"
  | "aborted_cost_cap"
  | "failed";

export type PerPatientState = "pending" | "running" | "complete" | "error";

export interface ConfidenceSummary {
  low: number;
  medium: number;
  high: number;
  unknown: number;
}

export interface PerPatientStatus {
  state: PerPatientState;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  cost_usd?: number;
  field_count?: number;
  /** Counts of agent-emitted confidence values across this patient's
   *  field_assessments. Populated on completion. */
  confidence_summary?: ConfidenceSummary;
  error?: string;
}

export interface RunManifest {
  run_id: string;
  label?: string;
  task_id: string;
  guideline_sha: string;
  started_at: string;
  started_by: string;
  patient_ids: string[];
  max_concurrency: number;
  max_turns_per_patient: number;
  model: string;
  cost_cap_usd: number;
  /** Discriminator for kinds of runs. CohortRunManifest narrows this to
   *  "cohort_batch_run". Future kinds (pilot, validation-only, etc.) widen
   *  this further. */
  kind: "agent_batch_run" | "cohort_batch_run";
  /** When set, this run belongs to a cohort (deployment-stage validation).
   *  The value is the cohort_id from cohorts/<cohort_id>/manifest.json. */
  cohort_id?: string;
  /** Agent role configurations for this run. When absent, a single default
   *  agent is implied for backwards compatibility. */
  agent_specs?: AgentSpec[];
  /**
   * Criterion-focused mode — when set, each agent invocation answers ONLY
   * these field_ids. The pilot orchestrator merges the partial draft with
   * the prior iteration's draft for carried criteria.
   *
   * Absent for whole-guideline runs (default behavior).
   */
  target_field_ids?: string[];
  /** The review session this run belongs to (when started from a session). Drives
   *  the session-scoped rubric fork the agent reads. Absent for cohort/lock-test
   *  runs with no session. */
  session_id?: string;
  /** The session rubric version active when this run executed (e.g. "s2") —
   *  provenance pinning which rubric the iter ran against. */
  rubric_version?: string;
  /** Agent provider used for this run. Per-run override of the
   *  AGENT_PROVIDER env var. Absent on manifests written before
   *  v0.7.1 — readers should fall back to the env-var default. */
  provider?: ProviderName;
}

export interface RunStatus {
  run_id: string;
  state: RunState;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  total_cost_usd: number;
  n_patients: number;
  n_complete: number;
  n_error: number;
  n_running: number;
  per_patient: Record<string, PerPatientStatus>;
}

export interface RunListing {
  run_id: string;
  task_id: string;
  label?: string;
  state: RunState;
  started_at: string;
  n_patients: number;
  n_complete: number;
  n_error: number;
  /** Agent provider used for this run. Absent on manifests written
   *  before per-run provider support; readers should display "default"
   *  or fall back to the env-var default in that case. */
  provider?: ProviderName;
}

// ── manifest normalizer ───────────────────────────────────────────────────────

/** Backwards-compatibility normalizer: injects an implicit single-agent
 *  default when reading manifests written before `agent_specs` was added. */
export function normalizeManifest(m: RunManifest): RunManifest {
  if (!m.agent_specs || m.agent_specs.length === 0) {
    return { ...m, agent_specs: [{ id: "agent_1", role_preset: "default", role_version: "v1" }] };
  }
  return m;
}

// ── filesystem layout ────────────────────────────────────────────────────────

export function runsRoot(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(PLATFORM_ROOT, "var", "runs");
}

export function runDir(runId: string): string {
  return path.join(runsRoot(), runId);
}

export function manifestPath(runId: string): string {
  return path.join(runDir(runId), "manifest.json");
}

export function statusPath(runId: string): string {
  return path.join(runDir(runId), "status.json");
}

export function perPatientDir(runId: string, patientId: string): string {
  return path.join(runDir(runId), "per_patient", patientId);
}

export function draftPath(runId: string, patientId: string): string {
  return path.join(perPatientDir(runId, patientId), "agent_draft.json");
}

export function auditPath(runId: string, patientId: string): string {
  return path.join(perPatientDir(runId, patientId), "audit.jsonl");
}

/** Path for multi-agent draft. agentId is e.g., "agent_1". */
export function agentDraftPath(runId: string, patientId: string, agentId: string): string {
  return path.join(perPatientDir(runId, patientId), "agents", `${agentId}.json`);
}

/** Path for per-agent transcript (AgentEvent JSONL). Captures every
 *  tool_use / tool_result / text / result event emitted by the
 *  provider — provider-agnostic, so we can verify what the agent
 *  actually read / called even when the SDK hooks don't fire (e.g.
 *  the codex provider). Sits next to the agent draft. */
export function agentTranscriptPath(runId: string, patientId: string, agentId: string): string {
  return path.join(perPatientDir(runId, patientId), "agents", `${agentId}_transcript.jsonl`);
}

/** Returns true if the patient has at least one agent draft from this run. */
export function hasAnyAgentDraft(runId: string, patientId: string): boolean {
  const dir = path.join(perPatientDir(runId, patientId), "agents");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.endsWith(".json") && !f.endsWith(".error.json"));
}

// ── read helpers ─────────────────────────────────────────────────────────────

export function getRunManifest(runId: string): RunManifest | null {
  const p = manifestPath(runId);
  if (!fs.existsSync(p)) return null;
  try {
    return normalizeManifest(JSON.parse(fs.readFileSync(p, "utf8")) as RunManifest);
  } catch {
    return null;
  }
}

export function getRunStatus(runId: string): RunStatus | null {
  const p = statusPath(runId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as RunStatus;
  } catch {
    return null;
  }
}

export function listRuns(filter?: { task_id?: string }): RunListing[] {
  const root = runsRoot();
  if (!fs.existsSync(root)) return [];
  const out: RunListing[] = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const m = getRunManifest(name);
    const s = getRunStatus(name);
    if (!m || !s) continue;
    if (filter?.task_id && m.task_id !== filter.task_id) continue;
    out.push({
      run_id: m.run_id,
      task_id: m.task_id,
      label: m.label,
      state: s.state,
      started_at: m.started_at,
      n_patients: s.n_patients,
      n_complete: s.n_complete,
      n_error: s.n_error,
      ...(m.provider ? { provider: m.provider } : {}),
    });
  }
  return out.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function readDraft(runId: string, patientId: string): unknown | null {
  const p = draftPath(runId, patientId);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }
  // Multi-agent runs don't write `agent_draft.json` (there's no canonical
  // single answer when two agents disagree). Fall back to the
  // lowest-numbered agent's draft so the existing review-import flow
  // (POST /api/runs/:runId/patients/:patientId/import) still has
  // something to materialize into review_state.
  const agentsDir = path.join(perPatientDir(runId, patientId), "agents");
  if (!fs.existsSync(agentsDir)) return null;
  const agentFiles = fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".error.json"))
    .sort();
  if (agentFiles.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(agentsDir, agentFiles[0]), "utf8"));
  } catch {
    return null;
  }
}

export function readAuditLines(runId: string, patientId: string): string[] {
  const p = auditPath(runId, patientId);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
}

// ── write helpers ────────────────────────────────────────────────────────────
// atomicWriteJson is imported above from ../../storage.js. Re-exported
// here so callers that import via the batch-run barrel keep working.
export { atomicWriteJson };

export function deleteRun(runId: string): boolean {
  const dir = runDir(runId);
  if (!fs.existsSync(dir)) return false;
  // Refuse to delete a run that is still running.
  const s = getRunStatus(runId);
  if (s && s.state === "running") {
    throw new Error(`run ${runId} is still running; abort it before deleting`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * One-shot reconcile at server startup. `driveRun` is an IN-PROCESS,
 * fire-and-forget loop — it cannot survive a server restart and runs are never
 * resumed. So any run still marked `running` at boot is, by definition,
 * orphaned: its driver died with the previous process and will never finalize
 * `status.json`. Left alone, the UI shows a phantom "RUNNING" badge forever
 * (the bug a server restart mid-run produces).
 *
 * For each orphaned run we recompute a terminal state from its per-patient
 * statuses (mirroring `driveRun`'s finalize): any patient still `pending` /
 * `running` becomes `error` (the agent never finished); already-terminal
 * patients are preserved so a run that completed most of its cohort before the
 * crash keeps those drafts. The run is then `complete` (all done),
 * `complete_with_errors` (some done), or `failed` (none done).
 *
 * Returns the run_ids it reconciled, for the boot log + tests. Run this BEFORE
 * `reconcilePilotStatesOnStartup` so a now-terminal run cascades: the pilot
 * reconciler advances the owning iter out of "running" too.
 */
export function reconcileOrphanedRunsOnStartup(now: Date = new Date()): string[] {
  const root = runsRoot();
  if (!fs.existsSync(root)) return [];
  const iso = now.toISOString();
  const reconciled: string[] = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const status = getRunStatus(name);
    if (!status || status.state !== "running") continue;

    const perPatient: Record<string, PerPatientStatus> = {};
    for (const [pid, pp] of Object.entries(status.per_patient)) {
      perPatient[pid] =
        pp.state === "pending" || pp.state === "running"
          ? {
              ...pp,
              state: "error",
              completed_at: pp.completed_at ?? iso,
              error:
                pp.error ??
                "run orphaned — server restarted while this patient was in progress",
            }
          : pp;
    }
    const nComplete = Object.values(perPatient).filter((p) => p.state === "complete").length;
    const nError = Object.values(perPatient).filter((p) => p.state === "error").length;
    const finalState: RunState =
      nComplete === 0 && nError > 0 ? "failed" : nError > 0 ? "complete_with_errors" : "complete";

    atomicWriteJson(statusPath(name), {
      ...status,
      state: finalState,
      updated_at: iso,
      completed_at: status.completed_at ?? iso,
      n_running: 0,
      n_complete: nComplete,
      n_error: nError,
      per_patient: perPatient,
    } satisfies RunStatus);
    reconciled.push(name);
  }
  return reconciled;
}

// ── id generation ────────────────────────────────────────────────────────────

export function generateRunId(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

// ── driver ───────────────────────────────────────────────────────────────────
//
// `startBatchRun` is fire-and-forget: it writes the manifest+initial status
// synchronously, kicks off an async loop that schedules per-patient query()
// invocations under a semaphore, and returns the run_id immediately.
//
// The async loop redirects review_state.json + audit-log writes into a
// per-run scratch tree via `withReviewsRoot`, then promotes the agent's
// final review_state.json to `runs/<run_id>/per_patient/<pid>/agent_draft
// .json`. Errors per patient are isolated; the run keeps going.

import { withReviewsRoot } from "@chart-review/domain-review";
import { runAgent, type AgentEvent } from "@chart-review/agent-provider";
import { modelFor } from "@chart-review/model-config";
import { atomicWriteJson } from "@chart-review/storage";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import { toolProfileFor, mcpAllowlist } from "@chart-review/task-tools";
import { buildAuditHooks } from "@chart-review/audit-trail";
import { loadCompiledTask, type CompiledTask } from "@chart-review/tasks";
import type { QuestionAnswer, RuleVerdict } from "@chart-review/platform-types";
import { computeTaskSha } from "@chart-review/lock";
import { guidelineDir, phenotypeSkillDir, resolveRubricRoot } from "@chart-review/rubric";
import { getActiveVersion } from "@chart-review/rubric-versions";
import { patientDir, listNotes, isPhiPatient, patientPersonId } from "@chart-review/patients";
import { resolveRolePrompt, validateAgentSpec } from "@chart-review/agent-specs";
import { extractSpansDirect } from "@chart-review/pipeline-extract-ner";
import { pathFor } from "@chart-review/storage";
// server/lib is the deployment's app code; packages reach into it via a
// relative path (same pattern as pipeline-validate's v1-judge). This is the
// SECRET-BEARING endpoint resolver — it reads python/models.json + env to
// return the LLM connection details the direct-LLM NER extractor needs. It is
// never wired into an Express route (unlike the presence-only `listModels`).
import { resolveModelEndpoint } from "../../../server/lib/model-registry.js";

/** Fold one AgentEvent into the running tally for an agent run. Counts
 *  set_field_assessment writes from the EVENT STREAM (not the SDK PostToolUse
 *  hook) — the deepagents subprocess provider emits events on stdout and never
 *  fires the JS hooks, so hook-based counting marked every successful deepagents
 *  agent as "no writes". The event stream fires for every provider. */
export function applyAgentEventToTally(
  tally: { agentError: string | null; writeCount: number },
  event: AgentEvent,
): { agentError: string | null; writeCount: number } {
  if (event.type === "error") {
    return { ...tally, agentError: event.error ?? "agent error" };
  }
  // Primary write tools per task kind: phenotype commits via
  // set_field_assessment, adherence via set_question_answer. Each run uses
  // exactly one, so counting both is safe (the other never fires).
  if (
    event.type === "tool_use" &&
    (event.tool_name === "set_field_assessment" ||
      event.tool_name === "set_question_answer")
  ) {
    return { ...tally, writeCount: tally.writeCount + 1 };
  }
  return tally;
}

/** Decide whether an agent run succeeded. An agent that emitted an error event,
 *  or that made zero set_field_assessment writes THIS run, did not produce a
 *  draft — promoting the seeded/carried-forward scratch would be a stale-answer
 *  bug (see the session-isolated-review-state spec). */
export function classifyAgentOutcome(
  o: { agentError: string | null; writeCount: number },
): { status: "ok" } | { status: "error"; error: string } {
  if (o.agentError) return { status: "error", error: o.agentError };
  if (o.writeCount === 0) {
    return { status: "error", error: "agent made no set_field_assessment writes this run" };
  }
  return { status: "ok" };
}

/** Per-patient status from its agents' outcomes:
 *  all agents failed → "failed"; some failed → "complete_with_errors"; all ok → "complete". */
export function rollupPatientStatus(
  outcomes: Array<{ status: "ok" | "error" }>,
): "complete" | "complete_with_errors" | "failed" {
  const ok = outcomes.filter((o) => o.status === "ok").length;
  if (ok === 0) return "failed";
  if (ok < outcomes.length) return "complete_with_errors";
  return "complete";
}

// ── NER helpers (run-loop NER branch) ─────────────────────────────────────────

/** The empty NER draft synthesized when a NER agent legitimately finds ZERO
 *  entities across all notes. mcp-core-ner only writes review_state.json once a
 *  span is persisted, so an honest empty result leaves no scratch file. The
 *  shape mirrors what persistState writes for an empty state (span_labels: []).
 *  An empty result is VALID — we promote this rather than force-failing. */
export function emptyNerDraft(patientId: string, taskId: string): {
  schema_version: string;
  patient_id: string;
  task_id: string;
  task_kind: "ner";
  review_status: "draft";
  version: number;
  updated_at: string;
  updated_by: "agent";
  span_labels: [];
} {
  return {
    schema_version: "1",
    patient_id: patientId,
    task_id: taskId,
    task_kind: "ner",
    review_status: "draft",
    version: 0,
    updated_at: new Date().toISOString(),
    updated_by: "agent",
    span_labels: [],
  };
}

/**
 * Resolve the concepts.json path for an NER task. Inlined here because concur
 * lacks v2's `mcp-server-ner-anthropic.resolveOntologyPath` (the NER MCP server
 * stack is deferred in concur's MVP). Walks candidates in order, returning the
 * first that exists on disk:
 *   1. `task.ontology_pin` of the form `<id>@<version>` → the pinned snapshot
 *      under `var/ontologies/<id>/<version>/concepts.json` (locked / immutable).
 *   2. `<guidelineDir(task_id)>/references/ontology/concepts.json` — vendored in
 *      the skill bundle (self-contained pre-lock; where N3 places the bso-ad
 *      ontology).
 * Falls back to the skill-dir path when none exist, deferring the ENOENT to the
 * read site (loadOntology) so the error is clear and synchronous resolution stays
 * predictable.
 */
export function resolveNerOntologyPath(task: CompiledTask): string {
  const candidates: string[] = [];
  const pin = (task as { ontology_pin?: string }).ontology_pin;
  if (pin && pin.includes("@")) {
    const [id, version] = pin.split("@");
    candidates.push(pathFor.ontologySnapshot(id!, version!));
  }
  const skillDirPath = path.join(
    guidelineDir(task.task_id),
    "references",
    "ontology",
    "concepts.json",
  );
  candidates.push(skillDirPath);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return skillDirPath;
}

// #47 — env-driven defaults so a deployment can lock in a cost ceiling
// without code changes. Falls back to sensible bounds for the bench.
const envInt = (k: string, fallback: number) => {
  const raw = process.env[k];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const DEFAULT_MAX_CONCURRENCY = envInt("CHART_REVIEW_MAX_CONCURRENCY", 3);

// Per-task tool surface now lives in @chart-review/task-tools (toolProfileFor +
// mcpAllowlist): the CHART_REVIEW_MCP_TOOLS allowlist each run pins is computed
// from the task's profile. See the adherence + phenotype paths below.
// Empirically: 30 turns is too tight for the chart-review skill on a typical
// The agent reads the guideline + all notes + all criterion YAMLs (8-15 turns)
// before it ever calls set_field_assessment. Reasoning models (e.g. Qwen3) burn
// extra turns thinking, and on long charts 60 turns (recursion_limit 130) hit
// the ceiling and failed without committing — so the default is 90
// (recursion_limit = 90*2+10 = 190). Override with CHART_REVIEW_MAX_TURNS_PER_PATIENT.
const DEFAULT_MAX_TURNS_PER_PATIENT = envInt("CHART_REVIEW_MAX_TURNS_PER_PATIENT", 90);
const DEFAULT_COST_CAP_USD = envInt("CHART_REVIEW_COST_CAP_USD", 50);

/** #47 — per-task cumulative cost across all completed runs. The UI
 *  surfaces this as a "spent so far" pill in PilotsPanel / Studio so
 *  methodologists notice budget drift without scraping run-by-run. */
export function cohortSpend(taskId: string): {
  task_id: string;
  total_cost_usd: number;
  n_runs: number;
  defaults: {
    cost_cap_usd: number;
    max_turns_per_patient: number;
    max_concurrency: number;
  };
} {
  const dir = runsRoot();
  let total = 0;
  let n = 0;
  if (fs.existsSync(dir)) {
    for (const rid of fs.readdirSync(dir)) {
      if (rid.startsWith(".")) continue;
      const m = path.join(dir, rid, "manifest.json");
      const s = path.join(dir, rid, "status.json");
      if (!fs.existsSync(m) || !fs.existsSync(s)) continue;
      try {
        const mj = JSON.parse(fs.readFileSync(m, "utf8")) as { task_id?: string };
        if (mj.task_id !== taskId) continue;
        const sj = JSON.parse(fs.readFileSync(s, "utf8")) as { total_cost_usd?: number };
        total += sj.total_cost_usd ?? 0;
        n += 1;
      } catch {
        /* skip */
      }
    }
  }
  return {
    task_id: taskId,
    total_cost_usd: total,
    n_runs: n,
    defaults: {
      cost_cap_usd: DEFAULT_COST_CAP_USD,
      max_turns_per_patient: DEFAULT_MAX_TURNS_PER_PATIENT,
      max_concurrency: DEFAULT_MAX_CONCURRENCY,
    },
  };
}

export interface StartBatchRunOptions {
  task_id: string;
  patient_ids: string[];
  started_by: string;
  label?: string;
  max_concurrency?: number;
  max_turns_per_patient?: number;
  cost_cap_usd?: number;
  /** N-agent configuration. Default: implicit single-agent default. */
  agent_specs?: AgentSpec[];
  /**
   * Criterion-focused mode — when set, the agent is instructed to answer
   * ONLY these field_ids and stop. Other fields are carried forward from
   * a prior iteration's draft by the pilot orchestrator (draft merging).
   *
   * When absent (undefined), the agent runs in whole-guideline mode
   * (default behavior, unchanged from MVP).
   */
  target_field_ids?: string[];
  /** When set, the run manifest records this cohort linkage so the run
   *  can be retrieved by cohort. No change to the run filesystem layout. */
  cohort_id?: string;
  /** The review session this run belongs to. When set, the run reads (and pins)
   *  this session's rubric fork; when omitted, the baseline. */
  session_id?: string;
  /** Per-run agent provider override. When omitted, falls back to the
   *  AGENT_PROVIDER env var resolved at server start. */
  provider?: ProviderName;
  /** Optional callback invoked after each status mutation. The driver
   *  calls this with the latest status; the route layer can broadcast
   *  on WS. */
  onStatus?: (status: RunStatus) => void;
}

export interface StartBatchRunResult {
  run_id: string;
  manifest: RunManifest;
}

/** Minimal semaphore: acquire to enter the critical section, call
 *  release() exactly once to free a slot. */
function makeSemaphore(limit: number) {
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        const enter = () => {
          inFlight++;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            inFlight--;
            const next = waiters.shift();
            if (next) next();
          };
          resolve(release);
        };
        if (inFlight < limit) enter();
        else waiters.push(enter);
      });
    },
  };
}

/** The rubric root a run reads from = the session's fork (or the baseline for a
 *  session-less run). Exposed for callers/tests that need to know which rubric a
 *  given (task, session) run resolves to. */
export function rubricRootForRun(taskId: string, sessionId?: string): string {
  return resolveRubricRoot(taskId, sessionId);
}

export function startBatchRun(opts: StartBatchRunOptions): StartBatchRunResult {
  if (!opts.patient_ids || opts.patient_ids.length === 0) {
    throw new Error("patient_ids must be non-empty");
  }
  const task = loadCompiledTask(opts.task_id);
  if (!task) {
    throw new Error(`task ${opts.task_id} not found`);
  }

  // Validate and default agent_specs — N=1 default when caller omits it.
  const specs: AgentSpec[] = opts.agent_specs && opts.agent_specs.length > 0
    ? opts.agent_specs
    : [{ id: "agent_1", role_preset: "default", role_version: "v1" }];
  validateAgentSpec(specs);

  const guidelinePath = guidelineDir(opts.task_id);
  const guidelineSha = computeTaskSha(guidelinePath);

  // Resolve "server default" to the concrete provider name so the manifest
  // is self-describing forever. Without this, a null `provider` is ambiguous
  // after the operator restarts the server with a different AGENT_PROVIDER.
  const resolvedProvider: ProviderName = opts.provider ?? defaultProviderName();

  const runId = generateRunId();
  // The session rubric version this run executes against (provenance pin). For a
  // session run this resolves the fork's active version; baseline otherwise.
  const rubricVersion = getActiveVersion(resolveRubricRoot(opts.task_id, opts.session_id)) ?? undefined;
  const manifest: RunManifest = {
    run_id: runId,
    label: opts.label,
    task_id: opts.task_id,
    guideline_sha: guidelineSha,
    started_at: new Date().toISOString(),
    started_by: opts.started_by,
    patient_ids: opts.patient_ids,
    max_concurrency: opts.max_concurrency ?? DEFAULT_MAX_CONCURRENCY,
    max_turns_per_patient: opts.max_turns_per_patient ?? DEFAULT_MAX_TURNS_PER_PATIENT,
    model: modelFor("default") ?? "(unset)",
    cost_cap_usd: opts.cost_cap_usd ?? DEFAULT_COST_CAP_USD,
    kind: "agent_batch_run",
    agent_specs: specs,
    provider: resolvedProvider,
    ...(opts.target_field_ids && opts.target_field_ids.length > 0
      ? { target_field_ids: opts.target_field_ids }
      : {}),
    ...(opts.cohort_id ? { cohort_id: opts.cohort_id } : {}),
    ...(opts.session_id ? { session_id: opts.session_id } : {}),
    ...(rubricVersion ? { rubric_version: rubricVersion } : {}),
  };

  fs.mkdirSync(runDir(runId), { recursive: true });
  atomicWriteJson(manifestPath(runId), manifest);

  const status: RunStatus = {
    run_id: runId,
    state: "running",
    started_at: manifest.started_at,
    updated_at: manifest.started_at,
    completed_at: null,
    total_cost_usd: 0,
    n_patients: opts.patient_ids.length,
    n_complete: 0,
    n_error: 0,
    n_running: 0,
    per_patient: Object.fromEntries(
      opts.patient_ids.map((pid) => [pid, { state: "pending" } as PerPatientStatus]),
    ),
  };
  atomicWriteJson(statusPath(runId), status);
  opts.onStatus?.(status);

  // Fire-and-forget async loop. Errors land in status.json as a "failed" run.
  driveRun(manifest, status, opts).catch((err) => {
    const failed: RunStatus = {
      ...status,
      state: "failed",
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };
    atomicWriteJson(statusPath(runId), failed);
    opts.onStatus?.(failed);
    console.error(`run ${runId} failed:`, err);
  });

  return { run_id: runId, manifest };
}

async function driveRun(
  manifest: RunManifest,
  status: RunStatus,
  opts: StartBatchRunOptions,
): Promise<void> {
  const { run_id: runId, task_id: taskId } = manifest;
  const sem = makeSemaphore(manifest.max_concurrency);
  let aborted = false;

  // Atomic mutator. The manifest is immutable; only `status` mutates.
  const mutate = (fn: (s: RunStatus) => void) => {
    fn(status);
    status.updated_at = new Date().toISOString();
    atomicWriteJson(statusPath(runId), status);
    opts.onStatus?.(status);
  };

  await Promise.all(
    manifest.patient_ids.map(async (pid) => {
      const release = await sem.acquire();
      if (aborted) {
        release();
        return;
      }
      try {
        mutate((s) => {
          s.per_patient[pid] = {
            state: "running",
            started_at: new Date().toISOString(),
          };
          s.n_running = (s.n_running ?? 0) + 1;
        });

        const t0 = Date.now();
        const out = await runOnePatient(manifest, pid);
        const ms = Date.now() - t0;

        mutate((s) => {
          // patient_status drives per-patient state and error counters:
          //   "failed"               → all agents errored; state="error", only n_error++
          //   "complete_with_errors" → some agents errored; state="complete", n_complete++ and n_error++
          //   "complete"             → all agents ok; state="complete", only n_complete++
          const perState: PerPatientState =
            out.patient_status === "failed" ? "error" : "complete";
          s.per_patient[pid] = {
            state: perState,
            started_at: s.per_patient[pid]?.started_at,
            completed_at: new Date().toISOString(),
            duration_ms: ms,
            cost_usd: out.cost_usd,
            field_count: out.field_count,
            confidence_summary: out.confidence_summary,
            ...(out.patient_status === "failed"
              ? { error: "all agents failed to produce a draft" }
              : {}),
          };
          s.n_running = Math.max(0, s.n_running - 1);
          if (out.patient_status !== "failed") s.n_complete += 1;
          if (out.patient_status !== "complete") s.n_error += 1;
          s.total_cost_usd = +(s.total_cost_usd + (out.cost_usd ?? 0)).toFixed(6);
        });

        if (status.total_cost_usd >= manifest.cost_cap_usd) {
          aborted = true;
        }
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        try {
          fs.mkdirSync(perPatientDir(runId, pid), { recursive: true });
          fs.writeFileSync(path.join(perPatientDir(runId, pid), "error.txt"), message);
        } catch { /* best-effort */ }
        mutate((s) => {
          s.per_patient[pid] = {
            state: "error",
            started_at: s.per_patient[pid]?.started_at,
            completed_at: new Date().toISOString(),
            error: message,
          };
          s.n_running = Math.max(0, s.n_running - 1);
          s.n_error += 1;
        });
      } finally {
        release();
      }
    }),
  );

  // Finalize
  // If every patient failed (n_complete === 0 and n_error > 0), the run is
  // "failed". If some patients failed or had partial errors, "complete_with_errors".
  // Otherwise "complete".
  const finalState: RunState = aborted
    ? "aborted_cost_cap"
    : status.n_complete === 0 && status.n_error > 0
      ? "failed"
      : status.n_error > 0
        ? "complete_with_errors"
        : "complete";
  mutate((s) => {
    s.state = finalState;
    s.completed_at = new Date().toISOString();
  });
  void taskId; // currently unused but reserved for future per-task index
}

/** One agent's result for one patient. `status:"error"` means the agent
 *  errored or made no writes (B1) — no draft was promoted. */
interface OneAgentOutput {
  status: "ok" | "error";
  cost_usd?: number;
  field_count?: number;
  confidence_summary?: ConfidenceSummary;
  error?: string;
}

/** A patient's rolled-up result across all its agents (B2). `patient_status`
 *  drives the driver's PerPatientState + the run's final RunState. */
interface OnePatientOutput {
  patient_status: "complete" | "complete_with_errors" | "failed";
  cost_usd?: number;
  field_count?: number;
  confidence_summary?: ConfidenceSummary;
}

async function runOnePatient(
  manifest: RunManifest,
  patientId: string,
): Promise<OnePatientOutput> {
  const specs = manifest.agent_specs ?? [{ id: "agent_1", role_preset: "default", role_version: "v1" }];
  let totalCost = 0;
  let totalFieldCount = 0;
  let mergedConfidence: ConfidenceSummary | undefined;
  const agentOutcomes: Array<{ status: "ok" | "error" }> = [];
  for (const spec of specs) {
    const out = await runOneAgent(manifest, patientId, spec);
    agentOutcomes.push({ status: out.status });
    totalCost += out.cost_usd ?? 0;
    totalFieldCount += out.field_count ?? 0;
    // Combine confidence summaries by summing buckets across agents.
    if (out.confidence_summary) {
      mergedConfidence = mergedConfidence ?? { low: 0, medium: 0, high: 0, unknown: 0 };
      mergedConfidence.low += out.confidence_summary.low;
      mergedConfidence.medium += out.confidence_summary.medium;
      mergedConfidence.high += out.confidence_summary.high;
      mergedConfidence.unknown += out.confidence_summary.unknown;
    }
  }
  maybeWriteLegacyDraft(manifest, patientId);
  const patient_status = rollupPatientStatus(agentOutcomes);
  return { patient_status, cost_usd: totalCost, field_count: totalFieldCount, confidence_summary: mergedConfidence };
}

/**
 * Compliance-aware model selection. PHI patients (meta.phi=true) MUST run on the
 * HIPAA-eligible model (modelFor("phi") — e.g. the Azure gpt-4o deployment), never
 * the default backend (here vLLM = OpenRouter, an external relay). Fail loudly if
 * a patient is PHI but no PHI model is configured: refuse to send PHI out rather
 * than silently fall back to the default.
 */
export function resolveAgentModel(
  isPhi: boolean,
  phiModel: string | undefined,
  specModel: string | undefined,
): string | undefined {
  if (!isPhi) return specModel;
  if (!phiModel) {
    throw new Error(
      "patient is PHI (meta.phi=true) but no PHI model is configured — set " +
        "CHART_REVIEW_PHI_MODEL to a HIPAA-eligible model key (e.g. gpt-4o) so PHI " +
        "is never sent to the default backend",
    );
  }
  return phiModel;
}

async function runOneAgent(
  manifest: RunManifest,
  patientId: string,
  spec: AgentSpec,
): Promise<OneAgentOutput> {
  const { run_id: runId, task_id: taskId } = manifest;
  const task = loadCompiledTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found at runtime`);

  // PHI patients run on the HIPAA-eligible model, never the default backend.
  // Throws (patient errors loudly) if PHI but CHART_REVIEW_PHI_MODEL is unset.
  const effectiveModel = resolveAgentModel(isPhiPatient(patientId), modelFor("phi"), spec.model);

  // The rubric root the agent's MCP criteria reads must resolve to: this session's
  // fork (or the baseline for legacy/session-less runs). Threaded into the
  // subprocess via CHART_REVIEW_RUBRIC_ROOT (buildMcpServersConfig) so read_criteria
  // hits the session rubric, not the baseline.
  const rubricRoot = resolveRubricRoot(taskId, manifest.session_id);

  const isNerTask = task.task_kind === "ner";
  const isAdherenceTask = task.task_kind === "adherence";

  const ppDir = perPatientDir(runId, patientId);
  fs.mkdirSync(path.join(ppDir, "agents"), { recursive: true });

  const scratchRoot = path.join(runDir(runId), `_scratch_state_${spec.id}`);
  const sessionId = `batch-${patientId}-${spec.id}-${Date.now()}`;

  const rolePrompt = resolveRolePrompt(spec);
  const skillDir = phenotypeSkillDir(taskId);
  const usingSkillFormat = fs.existsSync(skillDir);
  const guidelinePathLine = usingSkillFormat
    ? `Active guideline: ${taskId} (skill: ${path.relative(PLATFORM_ROOT, skillDir)})`
    : `Active guideline: ${taskId} (legacy path: ${path.relative(PLATFORM_ROOT, guidelineDir(taskId))})`;

  const targetFieldIds = manifest.target_field_ids;
  const targetFieldsLine =
    targetFieldIds && targetFieldIds.length > 0
      ? [
          "",
          `--- Criterion-focused mode ---`,
          `This run targets ONLY the following criteria (changed since the prior iteration):`,
          targetFieldIds.map((fid) => `  - ${fid}`).join("\n"),
          `Emit set_field_assessment ONLY for those fields and stop. Other fields are`,
          `carried forward from the prior iteration's draft — do NOT re-assess them.`,
          `--- End criterion-focused mode ---`,
        ].join("\n")
      : "";

  const phenotypePrompt = [
    `You are running in batch mode. Activate the \`chart-review\` skill.`,
    `If a skill named \`chart-review-${taskId}-phenotype\` exists, activate it as well — it provides the rubric scope.`,
    "",
    `Active patient: ${patientId}`,
    guidelinePathLine,
    "",
    `--- Role framing ---`,
    rolePrompt,
    `--- End role framing ---`,
    targetFieldsLine,
    "",
    "TOOL DISCIPLINE",
    "- BATCH reads first. To read all notes in one round-trip: `read_notes(filenames)`.",
    "  To read all rubric criteria in one round-trip: `read_criteria(field_ids)`.",
    "  Single-item variants (`read_note`, `read_criterion`) are for targeted",
    "  follow-up — not for the initial chart-walking step.",
    "- For ANY chart content (clinical notes): use the chart_review_state",
    "  MCP tools — `list_notes`, `read_notes` / `read_note`. Do NOT",
    "  `cat`/`sed`/`ls`/`rg` the filesystem to read patient files.",
    "- For EHR STRUCTURED DATA (OMOP tables — diagnoses, procedures, labs,",
    "  meds, observations): `list_structured_data` (no args) to see which",
    "  tables exist, then `read_structured_data({table})` for the relevant",
    "  ones. An empty list means this patient has no structured data — use",
    "  notes only; never `cat` the omop files.",
    "- For criterion definitions: use `list_criteria` + `read_criteria(field_ids)`.",
    "  Do NOT `cat criteria/*.md` or `for f in …; do cat $f; done` via shell.",
    "- Shell file-reads echo entire file bytes into every subsequent turn's",
    "  conversation history, blowing up token cost.",
    "- For writes: `set_field_assessment` (one per leaf criterion), `find_quote_offsets`",
    "  BEFORE citing any note quote (faithfulness gate), then `set_summary` and",
    "  `set_review_status` when done.",
    "- Use shell ONLY for operations no MCP tool exposes.",
    "",
    "First call `list_structured_data` (no args); if it returns non-empty",
    "tables, `read_structured_data({table})` the ones relevant to the criteria",
    "(e.g. conditions/observations for the diagnosis, conditions for distant",
    "metastasis or local recurrence). Then read the patient's notes via",
    "`list_notes` + `read_note`. Notes are the PRIMARY source; structured rows",
    "corroborate them or fill gaps. Then commit one",
    "assessment per",
    targetFieldIds && targetFieldIds.length > 0
      ? `targeted criterion via set_field_assessment (and select_evidence as needed).`
      : `leaf criterion via set_field_assessment (and select_evidence as needed).`,
    "Use find_quote_offsets BEFORE citing any note quote so faithfulness validation",
    "passes.",
    "",
    "EVIDENCE DISCIPLINE — cite the SMALLEST span that supports the answer:",
    "- Quote only the sentence or phrase that justifies the answer (≈1–2",
    "  sentences, well under 300 characters). Do NOT cite the whole note — a",
    "  citation spanning the entire document is not acceptable evidence.",
    "- ALWAYS cite at least one span, including for a 'no_info' answer: quote the",
    "  short section you checked where this information WOULD appear if present",
    "  (e.g. the Assessment/Plan, Diagnosis, or relevant History line). This",
    "  shows where you looked. Do NOT leave the evidence list empty, and do NOT",
    "  paste the full note to 'prove' absence.",
    "- When a STRUCTURED-DATA row supports the answer, cite it as evidence with",
    "  source:\"omop\", the `table` name, and the row's `row_id` (structured",
    "  evidence needs no note quote — the faithfulness gate only checks notes).",
    "",
    "After all leaf criteria are answered, you are done — emit a brief",
    "summary line and stop.",
  ].join("\n");

  const userPrompt = phenotypePrompt;

  let cost: number | undefined;
  let agentError: string | null = null;
  let writeCount = 0;
  // NER runs as a direct per-note LLM loop, not an agent loop, so it never
  // emits the `set_field_assessment` events `applyAgentEventToTally` counts.
  // A legitimately empty NER result (zero entities in every note) has
  // writeCount === 0 with no error — which `classifyAgentOutcome` would wrongly
  // fail. `nerCompleted` records that the per-note loop ran to the end without a
  // thrown/returned error, so we can treat an honest empty result as `ok`.
  let nerCompleted = false;
  // Adherence writes its own draft inline (question_answers + rule_verdicts)
  // rather than promoting the scratch review_state, so the post-loop promote
  // block must skip it. `adherenceDraftWritten` records that the inline draft
  // was produced on a successful outcome.
  let adherenceDraftWritten = false;
  const auditHooks = buildAuditHooks({ patientId, taskId, sessionId });

  await withReviewsRoot(scratchRoot, async () => {
    if (isNerTask) {
      // NER: direct LLM call per note, no agent loop, no MCP tool calls.
      // One round-trip per note (identify spans) plus a per-span normalize
      // call, instead of the ~50-tool-call agent loop. The endpoint is
      // resolved from the model registry (spec.model is a python/models.json
      // KEY); vllm entries map to OpenRouter, azure entries to the Responses
      // API. extractSpansDirect writes spans to the scratch reviewsRoot via
      // the mcp-core-ner disk-write helpers (same path the agent flow uses).
      const endpoint = resolveModelEndpoint(effectiveModel ?? "");
      if (!endpoint) {
        // Fail loudly — never guess an endpoint for an unknown model key.
        agentError = `NER: model '${effectiveModel ?? "(unset)"}' has no python/models.json entry`;
        return;
      }
      const ontologyPath = resolveNerOntologyPath(task);
      const notes = listNotes(patientId);
      const transcriptFp = agentTranscriptPath(runId, patientId, spec.id);
      // Best-effort transcript header so the existing log poll doesn't see an
      // empty file.
      try {
        fs.mkdirSync(path.dirname(transcriptFp), { recursive: true });
        fs.appendFileSync(transcriptFp, JSON.stringify({
          ts: new Date().toISOString(), type: "text",
          text: `direct-llm-ner: ${notes.length} note(s) for ${patientId}`,
        }) + "\n");
      } catch { /* ignore */ }

      for (const n of notes) {
        const noteId = n.filename.replace(/\.txt$/, "");
        let r: Awaited<ReturnType<typeof extractSpansDirect>>;
        try {
          r = await extractSpansDirect({
            patientId,
            task,
            noteId,
            ontologyPath,
            reviewsRoot: scratchRoot,
            sessionId,
            baseUrl: endpoint.baseUrl,
            apiKey: endpoint.apiKey,
            model: endpoint.model,
            mode: endpoint.mode,
            rolePreset: spec.role_preset,
          });
        } catch (e) {
          // A thrown error from the direct-LLM extractor is a loud-fail.
          agentError = (e as Error).message ?? String(e);
          break;
        }
        // Fold the structured result into the same tally the phenotype path
        // uses: spans_written counts as writes; r.error is a loud-fail.
        if (r.error) {
          agentError = r.error || "NER extractor error";
          break;
        }
        writeCount += r.spans_written ?? 0;
        try {
          fs.appendFileSync(transcriptFp, JSON.stringify({
            ts: new Date().toISOString(), type: "text",
            text: `note ${noteId}: ${r.spans_written} spans written, ${r.candidates_rejected} rejected`,
            usage: r.usage,
          }) + "\n");
        } catch { /* ignore */ }
        // Rough cost estimate from usage tokens (placeholder rates; the
        // manifest's cost_cap_usd just gates total spend).
        if (r.usage?.input_tokens) {
          const inT = r.usage.input_tokens ?? 0;
          const cachedT = r.usage.cached_input_tokens ?? 0;
          const outT = r.usage.output_tokens ?? 0;
          const est = ((inT - cachedT) * 2 + cachedT * 0.5 + outT * 10) / 1e6;
          cost = (cost ?? 0) + est;
        }
      }
      // Reaching here without an error means every note was processed (an
      // empty span list is a valid result).
      if (!agentError) nerCompleted = true;
      return;
    }

    if (isAdherenceTask) {
      // Adherence: agent loop via the stdio MCP server's adherence tools.
      // The agent commits one QuestionAnswer per question through
      // set_question_answer; after the loop the platform runs the
      // deterministic rule engine over the collected answers to produce
      // rule_verdicts (no LLM judge in concur's MVP). Mirrors the phenotype
      // agent-loop, NOT the NER direct-LLM path.
      //
      // The MCP config is the SAME stdio subprocess phenotype uses, but we
      // restrict the exposed tools to the adherence surface via the
      // CHART_REVIEW_MCP_TOOLS allowlist injected on the subprocess env. The
      // stdio server only registers the adherence write/read tools when the
      // task is task_kind:"adherence" AND the tool is in the allowlist.
      const adherenceTools = mcpAllowlist(toolProfileFor(task));
      const adherenceMcp = buildMcpServersConfig(
        patientId, task, sessionId, { onStateUpdate: () => {} },
        { reviewsRoot: scratchRoot, rubricRoot, provider: manifest.provider },
      ) as Record<string, { env?: Record<string, string> }>;
      // Inject the per-run tool allowlist into the subprocess env so only the
      // adherence tools are exposed (phenotype's set_field_assessment etc. stay
      // hidden). buildMcpServersConfig spreads process.env, so we override the
      // single key on the returned config rather than mutating process.env.
      for (const cfg of Object.values(adherenceMcp)) {
        cfg.env = { ...(cfg.env ?? {}), CHART_REVIEW_MCP_TOOLS: adherenceTools };
      }

      const adherenceUserPrompt = [
        `Adherence chart review for patient \`${patientId}\` on task \`${taskId}\`.`,
        "",
        `--- Role framing ---`,
        rolePrompt,
        `--- End role framing ---`,
        "",
        "FIRST ACTIONS — do these IMMEDIATELY before any reasoning. Do NOT call",
        "any generic discovery tool — the catalog you need is in your tool list.",
        "",
        "Step 1: call `list_questions` (no args) to see every question_id, its",
        "        tier / answer_schema / retrieval_hints. Each question's hint",
        "        tells you WHERE to look (OMOP structured table vs notes).",
        "Step 2: call `list_structured_data` (no args) ONCE to see which OMOP",
        "        tables this patient has and their row counts. Then call",
        "        `read_structured_data({table})` for EACH non-empty table the",
        "        questions reference — typically drugs, measurements, encounters,",
        "        observations, conditions, procedures. If a table is missing or",
        "        empty, fall back to the notes — do NOT fail.",
        "Step 3: call `list_notes` (no args) to see filenames, then read them",
        "        with `read_notes({filenames:[...]})` (one note per call) OR use",
        "        `search_notes({keyword})` to jump to a phrase (ACT, action plan,",
        "        fluticasone, spirometry, …) returning filename + offset + snippet.",
        "Step 4: For each question from step 1, call `set_question_answer({",
        "        question_id, answer, confidence, evidence, reasoning})` exactly",
        "        once. Use structured data when the question's retrieval_hints",
        "        say 'STRUCTURED FIRST' — that's the source of truth; notes are",
        "        the fallback. The platform coerces `answer` to the question's",
        "        schema; pass `null` when the chart doesn't support an answer.",
        "        Every NOTE evidence quote is faithfulness-checked — quote the",
        "        text VERBATIM from the note (use read_note to confirm). A quote",
        "        not found in the note is rejected; do not invent quotes.",
        "Step 5: After every question has been answered, call",
        "        `set_review_status({status:'complete'})`. The platform runs the",
        "        rule engine afterwards — you DO NOT compute rule verdicts yourself.",
        "",
        "Active tools (use ONLY these — in the recommended call order):",
        "  - list_questions          (catalog of questions, call once)",
        "  - list_structured_data    (catalog of OMOP tables, call ONCE)",
        "  - read_structured_data    (read one table by name; per non-empty table)",
        "  - list_notes              (catalog of notes, call once)",
        "  - search_notes            (keyword search across notes)",
        "  - read_note / read_notes  (read a note's text)",
        "  - set_question_answer     (call N times, one per question_id)",
        "  - set_review_status       (call once at the very end)",
        "Read-only escape hatches:",
        "  - read_question(question_id)   (one question's full definition)",
        "  - get_adherence_state          (what you've already committed)",
        "",
        "Do NOT use any other tool. No shell commands, no file IO, no resource",
        "discovery. Emit a brief one-line summary at the end and stop.",
      ].join("\n");

      const extraAdherenceSystem =
        "You are running unattended in batch mode. There is no human in the "
        + "loop for this patient — commit every question answer through the MCP "
        + "tools and stop. Do not ask clarifying questions; pick the most "
        + "defensible answer with the evidence available.";

      const adhSdkHooks: Record<string, Array<{ hooks: any[] }>> = {
        PreToolUse: [{ hooks: [auditHooks.pre] }],
        PostToolUse: [{ hooks: [auditHooks.post] }],
      };

      try {
        for await (const event of runAgent({
          prompt: adherenceUserPrompt,
          cwd: patientDir(patientId),
          patientId,
          taskId,
          guidelinePath: guidelineDir(taskId),
          mcpServers: adherenceMcp as Record<string, unknown>,
          hooks: adhSdkHooks,
          maxTurns: manifest.max_turns_per_patient,
          permissionMode: "acceptEdits",
          model: effectiveModel,
          provider: manifest.provider,
          transcriptPath: agentTranscriptPath(runId, patientId, spec.id),
          extraSystemPrompt: extraAdherenceSystem,
        })) {
          if (event.type === "result" && typeof event.cost_usd === "number") {
            cost = (cost ?? 0) + event.cost_usd;
          }
          const t = applyAgentEventToTally({ agentError, writeCount }, event);
          agentError = t.agentError;
          writeCount = t.writeCount;
        }
      } catch (e) {
        // A THROWN error (transport crash, provider exception) is a loud-fail
        // for this agent rather than crashing the whole run.
        agentError = (e as Error).message ?? String(e);
      }

      // Gate before computing/writing the draft: an agent that errored or made
      // no set_question_answer writes did not produce a draft this run.
      if (classifyAgentOutcome({ agentError, writeCount }).status === "error") {
        return;
      }

      // Post-agent: load the committed question_answers from the scratch
      // review_state, run the deterministic rule engine (eligibility gate
      // included), and write BOTH question_answers + rule_verdicts into the
      // per-agent draft (mirrors the phenotype promote, but inline since the
      // verdicts are computed here, not by the agent).
      const { evaluateAllRules } = await import("@chart-review/rule-engine");
      const { loadAdherenceSkill } = await import(
        "@chart-review/pipeline-extract-adherence"
      );
      const skill = loadAdherenceSkill(taskId);
      const scratchStateFp = path.join(scratchRoot, patientId, taskId, "review_state.json");
      let questionAnswers: QuestionAnswer[] = [];
      if (fs.existsSync(scratchStateFp)) {
        try {
          const state = JSON.parse(fs.readFileSync(scratchStateFp, "utf8")) as {
            question_answers?: QuestionAnswer[];
          };
          questionAnswers = state.question_answers ?? [];
        } catch { /* leave empty */ }
      }
      // Eligibility gate — if the conventional `R-T0-Eligible` rule resolves
      // to EXCLUDED, every rule becomes EXCLUDED.
      const eligibilityRule = skill.rules.find((r) => r.rule_id === "R-T0-Eligible");
      let auditExcluded = false;
      if (eligibilityRule) {
        const eligV = await evaluateAllRules([eligibilityRule], questionAnswers);
        auditExcluded = eligV[0]?.verdict === "EXCLUDED";
      }
      const ruleVerdicts: RuleVerdict[] = auditExcluded
        ? skill.rules.map((r) => ({
            rule_id: r.rule_id,
            verdict: "EXCLUDED" as const,
            supporting_questions: r.supporting_questions,
            source: "rule_engine" as const,
            ts: new Date().toISOString(),
          }))
        : await evaluateAllRules(skill.rules, questionAnswers);

      const draftFp = agentDraftPath(runId, patientId, spec.id);
      fs.mkdirSync(path.dirname(draftFp), { recursive: true });
      atomicWriteJson(draftFp, {
        schema_version: "1",
        patient_id: patientId,
        task_id: taskId,
        task_kind: "adherence",
        review_status: "draft",
        version: 1,
        updated_at: new Date().toISOString(),
        updated_by: "agent",
        field_assessments: [],
        question_answers: questionAnswers,
        rule_verdicts: ruleVerdicts,
        adherence_excluded: auditExcluded || undefined,
        lock_task_sha: manifest.guideline_sha,
      });
      adherenceDraftWritten = true;
      return;
    }

    // Transport (in-process vs subprocess) is selected by the
    // MCP_TRANSPORT env var. The default is in-process for backward
    // compat; set MCP_TRANSPORT=subprocess to spawn the standalone
    // stdio server for non-Anthropic providers (Codex etc.).
    //
    // Pass scratchRoot to the subprocess via env var: the in-process
    // path uses AsyncLocalStorage (`withReviewsRoot`) to redirect
    // writes here, but that context doesn't cross process boundaries.
    // The subprocess server reads CHART_REVIEW_REVIEWS_ROOT env var.
    const mcpServers: Record<string, unknown> = buildMcpServersConfig(
      patientId, task, sessionId, { onStateUpdate: () => {} },
      { reviewsRoot: scratchRoot, rubricRoot, provider: manifest.provider },
    );
    // Pin the phenotype tool allowlist on the subprocess env (mirrors the
    // adherence path). Scopes the agent to the notes/criteria/write surface +
    // EHR tools only when the task declares uses_structured_data — so a
    // notes-only task is not handed the structured-data tools at all.
    const profile = toolProfileFor(task);
    for (const cfg of Object.values(mcpServers) as Array<{ env?: Record<string, string> }>) {
      cfg.env = { ...(cfg.env ?? {}), CHART_REVIEW_MCP_TOOLS: mcpAllowlist(profile) };
    }
    // Plugin tools' run context. Cohort-CSV tasks (RUCAM) read a shared CSV dir
    // (CHART_REVIEW_RUCAM_DATA_DIR) filtered by the patient's PERSON_ID — both
    // force-bound so the agent can't pick the patient/dir. Other tasks bind the
    // patient's own dir.
    const isCohortCsv = profile.dataSource === "rucam-csv";
    const pluginDataDir = isCohortCsv
      ? (process.env.CHART_REVIEW_RUCAM_DATA_DIR ?? patientDir(patientId))
      : patientDir(patientId);
    const pluginBind = isCohortCsv ? { person_id: patientPersonId(patientId) } : undefined;
    // When the profile declares skills, load this task's own skill bundle
    // (SKILL.md + references/, e.g. RUCAM's per-item scoring methodology). The
    // sidecar roots the skill backend at .claude/skills, so this resolves there.
    const skills = profile.skills.length ? [`/chart-review-${taskId}/`] : undefined;
    const sdkHooks: Record<string, Array<{ hooks: any[] }>> = {
      PreToolUse: [{ hooks: [auditHooks.pre] }],
      PostToolUse: [{ hooks: [auditHooks.post] }],
    };
    const extraSystem = "You are running unattended in batch mode. There is no human in the "
      + "loop for this patient — produce your draft and stop. Do not ask "
      + "clarifying questions; pick the most defensible answer with the "
      + "evidence available.";

    // Phenotype: one agent loop per patient (one combined assessment).
    for await (const event of runAgent({
      prompt: userPrompt,
      cwd: patientDir(patientId),
      patientId,
      taskId,
      guidelinePath: guidelineDir(taskId),
      mcpServers,
      hooks: sdkHooks,
      maxTurns: manifest.max_turns_per_patient,
      permissionMode: "acceptEdits",
      model: effectiveModel,
      provider: manifest.provider,
      transcriptPath: agentTranscriptPath(runId, patientId, spec.id),
      extraSystemPrompt: extraSystem,
      pythonPlugins: profile.pythonPlugins,
      dataDir: pluginDataDir,
      pluginBind,
      skills,
      perItem: profile.perItem,
      perItemMaxAttempts: 2,
    })) {
      if (event.type === "result" && typeof event.cost_usd === "number") {
        cost = (cost ?? 0) + event.cost_usd;
      }
      const t = applyAgentEventToTally({ agentError, writeCount }, event);
      agentError = t.agentError;
      writeCount = t.writeCount;
    }
  });

  // Gate the promote on the outcome: an agent that errored or made no
  // primary writes did not produce a draft this run. Promoting the
  // seeded/carried-forward scratch would be a stale-answer bug.
  //
  // NER differs from phenotype here: zero spans is a VALID result (a chart
  // with no taggable entities), so an empty NER run that completed without
  // an error is `ok` even though writeCount === 0. classifyAgentOutcome's
  // writeCount>0 rule would wrongly fail it, so NER classifies on its own
  // completion signal instead.
  const outcome: { status: "ok" } | { status: "error"; error: string } = isNerTask
    ? (agentError
        ? { status: "error", error: agentError }
        : nerCompleted
          ? { status: "ok" }
          : { status: "error", error: "NER produced no completion signal this run" })
    : classifyAgentOutcome({ agentError, writeCount });
  if (outcome.status === "error") {
    // Do NOT promote: a seeded/carried scratch is not this run's output.
    const markerPath = path.join(ppDir, "agents", `${spec.id}.error.json`);
    try {
      fs.writeFileSync(markerPath, JSON.stringify(
        { agent_id: spec.id, status: "error", error: outcome.error }, null, 2));
    } catch { /* marker is best-effort */ }
    return { status: "error", error: outcome.error, cost_usd: cost };
  }

  // Success: promote the scratch review_state written by the MCP/extract loop.
  //
  // Adherence is the exception — its branch already wrote the final draft
  // inline (question_answers + the rule-engine's rule_verdicts), gated on the
  // same outcome. There is no separate scratch-to-draft promote for it.
  if (isAdherenceTask) {
    if (!adherenceDraftWritten) {
      throw new Error(`agent ${spec.id} (adherence) finished ok but wrote no draft — internal error`);
    }
  } else {
    const scratchReviewState = path.join(scratchRoot, patientId, taskId, "review_state.json");
    if (!fs.existsSync(scratchReviewState)) {
      if (isNerTask) {
        // Empty-NER-is-valid: mcp-core-ner only writes review_state.json once a
        // span is persisted, so an honest zero-entity result leaves NO scratch
        // file. Synthesize and promote an empty NER draft rather than failing.
        atomicWriteJson(agentDraftPath(runId, patientId, spec.id), emptyNerDraft(patientId, taskId));
      } else {
        throw new Error(`agent ${spec.id} reported writes but no review_state.json — internal error`);
      }
    } else {
      fs.renameSync(scratchReviewState, agentDraftPath(runId, patientId, spec.id));
    }
  }

  const scratchChat = path.join(scratchRoot, patientId, taskId, "chat", `${sessionId}.jsonl`);
  if (fs.existsSync(scratchChat)) {
    const auditDir = path.join(ppDir, "agents", spec.id + "_audit");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.renameSync(scratchChat, path.join(auditDir, `${sessionId}.jsonl`));
  }

  let fieldCount: number | undefined;
  let confidenceSummary: ConfidenceSummary | undefined;
  try {
    const draft = JSON.parse(fs.readFileSync(agentDraftPath(runId, patientId, spec.id), "utf8")) as {
      field_assessments?: Array<{ confidence?: "low" | "medium" | "high" }>;
      span_labels?: unknown[];
      question_answers?: Array<{ confidence?: number }>;
    };
    if (isAdherenceTask) {
      // For adherence, `field_count` reflects "answers produced" — a non-zero
      // progress indicator for the status panel. Bucket the numeric confidence
      // (0..1) into low/medium/high, same affordance phenotype tasks get.
      fieldCount = draft.question_answers?.length;
      if (draft.question_answers) {
        confidenceSummary = { low: 0, medium: 0, high: 0, unknown: 0 };
        for (const a of draft.question_answers) {
          if (a.confidence == null) confidenceSummary.unknown++;
          else if (a.confidence < 0.5) confidenceSummary.low++;
          else if (a.confidence < 0.8) confidenceSummary.medium++;
          else confidenceSummary.high++;
        }
      }
    } else if (isNerTask) {
      // For NER, `field_count` semantically becomes "span count" — a non-zero
      // progress indicator for the status panel. Spans don't carry confidence.
      fieldCount = draft.span_labels?.length;
    } else {
      fieldCount = draft.field_assessments?.length;
      if (draft.field_assessments) {
        confidenceSummary = { low: 0, medium: 0, high: 0, unknown: 0 };
        for (const f of draft.field_assessments) {
          if (f.confidence === "low") confidenceSummary.low++;
          else if (f.confidence === "medium") confidenceSummary.medium++;
          else if (f.confidence === "high") confidenceSummary.high++;
          else confidenceSummary.unknown++;
        }
      }
    }
  } catch { /* leave unset */ }

  return { status: "ok", cost_usd: cost, field_count: fieldCount, confidence_summary: confidenceSummary };
}

/** When a manifest has exactly one agent, also write the agent's draft to the legacy
 *  `agent_draft.json` path so the existing single-agent reviewer UI keeps working. */
function maybeWriteLegacyDraft(manifest: RunManifest, patientId: string): void {
  const specs = manifest.agent_specs ?? [];
  if (specs.length !== 1) return;
  const fp = agentDraftPath(manifest.run_id, patientId, specs[0].id);
  const legacy = draftPath(manifest.run_id, patientId);
  if (fs.existsSync(fp) && !fs.existsSync(legacy)) {
    fs.copyFileSync(fp, legacy);
  }
}

