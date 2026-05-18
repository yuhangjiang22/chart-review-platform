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
  return fs.readdirSync(dir).some((f) => f.endsWith(".json"));
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
    .filter((f) => f.endsWith(".json"))
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
import { runAgent } from "@chart-review/agent-provider";
import { modelFor } from "@chart-review/model-config";
import { atomicWriteJson } from "@chart-review/storage";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import { buildNerMcpServersConfig } from "@chart-review/mcp-server-ner-anthropic";
import { buildAuditHooks } from "@chart-review/audit-trail";
import { loadCompiledTask } from "@chart-review/tasks";
import { computeTaskSha } from "@chart-review/lock";
import { guidelineDir, phenotypeSkillDir } from "@chart-review/rubric";
import { patientDir, listNotes } from "@chart-review/patients";
import { resolveRolePrompt, validateAgentSpec } from "@chart-review/agent-specs";

// #47 — env-driven defaults so a deployment can lock in a cost ceiling
// without code changes. Falls back to sensible bounds for the bench.
const envInt = (k: string, fallback: number) => {
  const raw = process.env[k];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const DEFAULT_MAX_CONCURRENCY = envInt("CHART_REVIEW_MAX_CONCURRENCY", 3);
// Empirically: 30 turns is too tight for the chart-review skill on a typical
// 11-criterion guideline — the agent reads the guideline + all notes + all
// criterion YAMLs (8-15 turns) before it ever calls set_field_assessment, and
// runs out before committing answers. Default 60 leaves room for ~25-30 read
// turns and ~25 commits. See real-test results in commit 3fdd1c3.
const DEFAULT_MAX_TURNS_PER_PATIENT = envInt("CHART_REVIEW_MAX_TURNS_PER_PATIENT", 60);
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
          s.per_patient[pid] = {
            state: "complete",
            started_at: s.per_patient[pid]?.started_at,
            completed_at: new Date().toISOString(),
            duration_ms: ms,
            cost_usd: out.cost_usd,
            field_count: out.field_count,
            confidence_summary: out.confidence_summary,
          };
          s.n_running = Math.max(0, s.n_running - 1);
          s.n_complete += 1;
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
  const finalState: RunState = aborted
    ? "aborted_cost_cap"
    : status.n_error > 0
      ? "complete_with_errors"
      : "complete";
  mutate((s) => {
    s.state = finalState;
    s.completed_at = new Date().toISOString();
  });
  void taskId; // currently unused but reserved for future per-task index
}

interface OnePatientOutput {
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
  for (const spec of specs) {
    const out = await runOneAgent(manifest, patientId, spec);
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
  return { cost_usd: totalCost, field_count: totalFieldCount, confidence_summary: mergedConfidence };
}

async function runOneAgent(
  manifest: RunManifest,
  patientId: string,
  spec: AgentSpec,
): Promise<OnePatientOutput> {
  const { run_id: runId, task_id: taskId } = manifest;
  const task = loadCompiledTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found at runtime`);

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

  // task_kind dispatch — phenotype tasks use the chart_review_state MCP
  // server (7 cell tools, set_field_assessment, find_quote_offsets, …).
  // NER tasks use chart_review_ner (7 span tools, set_span_label,
  // locate_in_source, …) plus a span-shaped batch prompt. Same runAgent
  // loop, same scratch + audit promotion logic afterwards.
  const isNerTask = task.task_kind === "ner";
  const isAdherenceTask = task.task_kind === "adherence";
  if (isAdherenceTask) {
    throw new Error(
      "task_kind=adherence is not yet implemented (Phase 1). "
      + `See ADHERENCE-INTEGRATION.md. Task: ${taskId}`,
    );
  }

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
    "Read the patient's notes (under your cwd), then commit one assessment per",
    targetFieldIds && targetFieldIds.length > 0
      ? `targeted criterion via the chart_review_state MCP tools (set_field_assessment,`
      : `leaf criterion via the chart_review_state MCP tools (set_field_assessment,`,
    "select_evidence). Use find_quote_offsets BEFORE citing any note quote so",
    "faithfulness validation passes. After all leaf criteria are answered,",
    "you are done — emit a brief summary line and stop.",
  ].join("\n");

  // NER: prompt is built PER NOTE (one runAgent call per note) — keeps
  // the model's context tiny so Azure / OpenAI don't choke on aggregated
  // clinical content. The set_span_label MCP writes accumulate across
  // calls into the same review_state.json (same scratchRoot).
  function buildNerPromptForNote(noteId: string): string {
    // The note path is unambiguous: agent's cwd is the patient dir
    // (corpus/patients/<pid>/) and notes live in the `notes/` subdir.
    // Pass an explicit relative path so the agent doesn't waste turns
    // exploring cwd.
    const notePath = `notes/${noteId}.txt`;
    return [
      `Research cataloging task: index biomedical concepts from one IRB-approved de-identified clinical note for an annotation study.`,
      "",
      `Note to index this turn: \`${notePath}\` (read this single file; do not enumerate the directory).`,
      `Active ontology: BSO-AD (social determinants of Alzheimer's research).`,
      `Skill bundle: chart-review-ner + chart-review-${taskId} (load via Skill tool if available).`,
      "",
      "Steps:",
      `1. Read \`${notePath}\`.`,
      "2. Call `list_entity_types` to see the 9 BSO-AD root labels.",
      "3. For each label-applicable phrase in the note, call:",
      "   `normalize_to_ontology(entity_type, label)` → `locate_in_source(note_id, anchor, text)` → `set_span_label(...)`",
      `   (use note_id="${noteId}" — without the .txt extension or notes/ prefix).`,
      "4. Skip phrases that don't map to a BSO-AD entity_type. Empty output is acceptable.",
      "5. Emit a one-line summary and stop.",
      "",
      `This is structured indexing for downstream κ statistics — not narrative summarization or diagnosis. Use the most specific ontology concept where unambiguous; otherwise mark status="novel_candidate".`,
    ].join("\n");
  }

  const userPrompt = isNerTask ? "" /* unused — NER loops per-note */ : phenotypePrompt;

  let cost: number | undefined;
  const auditHooks = buildAuditHooks({ patientId, taskId, sessionId });

  await withReviewsRoot(scratchRoot, async () => {
    // Transport (in-process vs subprocess) is selected by the
    // MCP_TRANSPORT env var. The default is in-process for backward
    // compat; set MCP_TRANSPORT=subprocess to spawn the standalone
    // stdio server for non-Anthropic providers (Codex etc.).
    //
    // Pass scratchRoot to the subprocess via env var: the in-process
    // path uses AsyncLocalStorage (`withReviewsRoot`) to redirect
    // writes here, but that context doesn't cross process boundaries.
    // The subprocess server reads CHART_REVIEW_REVIEWS_ROOT env var.
    const mcpServers: Record<string, unknown> = isNerTask
      ? buildNerMcpServersConfig(
          patientId, task, sessionId, { onStateUpdate: () => {} },
          { reviewsRoot: scratchRoot, provider: manifest.provider },
        )
      : buildMcpServersConfig(
          patientId, task, sessionId, { onStateUpdate: () => {} },
          { reviewsRoot: scratchRoot, provider: manifest.provider },
        );
    const sdkHooks: Record<string, Array<{ hooks: any[] }>> = {
      PreToolUse: [{ hooks: [auditHooks.pre] }],
      PostToolUse: [{ hooks: [auditHooks.post] }],
    };
    const extraSystem = isNerTask
      ? "Research annotation context: IRB-approved, de-identified clinical text for "
        + "academic NLP study (inter-rater reliability of BSO-AD ontology mapping). "
        + "Index the structured spans the ontology defines; skip what doesn't apply. "
        + "Do not interpret diagnostically; do not produce narrative summaries."
      : "You are running unattended in batch mode. There is no human in the "
        + "loop for this patient — produce your draft and stop. Do not ask "
        + "clarifying questions; pick the most defensible answer with the "
        + "evidence available.";

    if (isNerTask) {
      // NER: direct LLM call per note, no agent loop, no MCP tool calls.
      // 1 round-trip per note instead of ~50 (one per span × 3 MCP tools
      // for normalize/locate/set_span_label). ~95% cost reduction.
      const { extractSpansDirect } = await import("@chart-review/pipeline-extract-ner");
      const { resolveOntologyPath } = await import("@chart-review/mcp-server-ner-anthropic");
      const ontologyPath = resolveOntologyPath(task);
      const azureBaseUrl = process.env.AZURE_OPENAI_BASE_URL
        ?? "https://iu-bhds-nlp-project.services.ai.azure.com/openai/v1";
      const azureApiKey = process.env.AZURE_OPENAI_API_KEY ?? "";
      const notes = listNotes(patientId);
      const transcriptFp = agentTranscriptPath(runId, patientId, spec.id);
      // Best-effort transcript header so the existing AgentLogPanel
      // poll doesn't see an empty file.
      try {
        fs.mkdirSync(path.dirname(transcriptFp), { recursive: true });
        fs.appendFileSync(transcriptFp, JSON.stringify({
          ts: new Date().toISOString(), type: "text",
          text: `direct-llm-ner: ${notes.length} note(s) for ${patientId}`,
        }) + "\n");
      } catch { /* ignore */ }
      {
        for (const n of notes) {
          const noteId = n.filename.replace(/\.txt$/, "");
          const r = await extractSpansDirect({
            patientId,
            task,
            noteId,
            ontologyPath,
            reviewsRoot: scratchRoot,
            sessionId,
            azureBaseUrl,
            azureApiKey,
            model: spec.model,
          });
          try {
            fs.appendFileSync(transcriptFp, JSON.stringify({
              ts: new Date().toISOString(), type: "text",
              text: `note ${noteId}: ${r.spans_written} spans written, ${r.candidates_rejected} rejected`
                + (r.error ? ` — ERROR: ${r.error}` : ""),
              usage: r.usage,
            }) + "\n");
          } catch { /* ignore */ }
          // Translate usage tokens to a rough cost estimate (placeholder
          // rates; the manifest's cost_cap_usd just gates total spend).
          if (r.usage?.input_tokens) {
            const inT = r.usage.input_tokens ?? 0;
            const cachedT = r.usage.cached_input_tokens ?? 0;
            const outT = r.usage.output_tokens ?? 0;
            // $2/M input, $0.5/M cached, $10/M output — rough Azure tier.
            const est = ((inT - cachedT) * 2 + cachedT * 0.5 + outT * 10) / 1e6;
            cost = (cost ?? 0) + est;
          }
        }
      }
    } else {
      // Phenotype: one agent loop per patient (one combined assessment).
      {
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
          model: spec.model,
          provider: manifest.provider,
          transcriptPath: agentTranscriptPath(runId, patientId, spec.id),
          extraSystemPrompt: extraSystem,
        })) {
          if (event.type === "result" && typeof event.cost_usd === "number") {
            cost = (cost ?? 0) + event.cost_usd;
          }
        }
      }
    }
  });

  const scratchReviewState = path.join(scratchRoot, patientId, taskId, "review_state.json");
  if (!fs.existsSync(scratchReviewState)) {
    throw new Error(`agent ${spec.id} finished but did not write review_state.json — likely no MCP writes`);
  }
  fs.renameSync(scratchReviewState, agentDraftPath(runId, patientId, spec.id));

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
      span_labels?: Array<{ entity_type?: string }>;
    };
    if (isNerTask) {
      // For NER tasks, `field_count` semantically becomes "span count".
      // The post-run pipeline (auto-advance, status broadcaster) uses it
      // as a non-zero-progress indicator; the exact label doesn't matter.
      // Confidence summary is left undefined — NER spans don't carry it.
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

  return { cost_usd: cost, field_count: fieldCount, confidence_summary: confidenceSummary };
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

