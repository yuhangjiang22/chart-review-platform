/**
 * infra/batch-run — N-patient parallel agent invocation, the queue, the
 * concurrency cap, the cost cap. The execution plumbing for any batch
 * (Iter dev runs, deployment Cohort runs, lock-test runs).
 *
 * This is *infrastructure* — concept-agnostic. The Iter and Cohort domain
 * modules call into here when they need a batch of agent invocations. The
 * batch-run module doesn't know what an Iter or a Cohort is.
 *
 * External callers should import from `./infra/batch-run/index.js`.
 */

export {
  type RunState,
  type PerPatientState,
  type ConfidenceSummary,
  type PerPatientStatus,
  type RunManifest,
  type RunStatus,
  type RunListing,
  type StartBatchRunOptions,
  type StartBatchRunResult,
  // Layout helpers
  runsRoot,
  runDir,
  manifestPath,
  statusPath,
  perPatientDir,
  draftPath,
  auditPath,
  agentDraftPath,
  // Read helpers
  hasAnyAgentDraft,
  getRunManifest,
  getRunStatus,
  listRuns,
  readDraft,
  readAuditLines,
  // Lifecycle
  startBatchRun,
  deleteRun,
  generateRunId,
  cohortSpend,
  // Persistence helpers
  normalizeManifest,
  atomicWriteJson,
} from "./runs.js";
