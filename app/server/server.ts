import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { WSClient, IncomingWSMessage } from "./types.js";
import { chatStore } from "./chat-store.js";
import { Session } from "./session.js";
import { PLATFORM_ROOT, listPatients, listNotes, readNote, readStructured } from "./patients.js";
import { listCompiledTasks, loadCompiledTask } from "./tasks.js";
import {
  applyUiAction,
  load as loadReviewState,
  type ReviewState,
  REVIEWS_ROOT,
} from "./domain/review/index.js";
import {
  appendAuditEntry,
  readFieldHistory,
} from "./audit-trail.js";
import { draftTask, listDrafts, readDraft, promoteDraft, startDraftJob } from "./authoring.js";
import {
  getJobManifest,
  getJobStatus,
  readJobTranscript,
  listJobs,
} from "./jobs.js";
import { analyzeCohort, loadCohortFeedback, listCohortRuns as listFeedbackCohortRuns, readCohortRun } from "./feedback.js";
import {
  startBatchRun,
  getRunManifest,
  getRunStatus,
  listRuns,
  readDraft as readRunDraft,
  readAuditLines as readRunAuditLines,
  deleteRun,
  perPatientDir,
  type RunStatus,
} from "./infra/batch-run/index.js";
import {
  startPilotIteration,
  listPilotIterations,
  getPilotManifest,
  getPilotCritique,
  selfCritiquePilot,
  setPilotState,
  fireAutoCritique,
  pilotIterationStats,
  readPrimaryCriterionIds,
  extractDisagreements,
  type PilotState,
  computeIterAccuracy,
  persistIterAccuracy,
  writeIterReport,
  maybeAutoAdvancePilotOnRunStatus,
  reconcilePilotStatesOnStartup,
} from "./domain/iter/index.js";
import { writeAdjudication, listAdjudications, type Adjudication } from "./adjudications.js";
import { loadCriteria } from "./domain/rubric/index.js";
import { criterionSchemaHash, computeRerunPlan } from "./criterion-hash.js";
import { computeEligibility, type IterSnapshot } from "./eligibility.js";
import { getMaturity } from "./maturity.js";
import { notify } from "./notifications.js";
import {
  authMiddleware,
  authMode,
  resolveToken,
  reviewerIdOf,
  isMethodologist,
} from "./auth.js";
import { reviewerRouter } from "./routes-reviewer.js";
import { computeQAStats } from "./qa-panel.js";
import { methodologistRouter } from "./methodologist.js";
import { listVersions, loadVersionedTask } from "./version-archive.js";
import { computeTaskDiff } from "./task-diff.js";
import { draftMethodsSection, listMethodsDrafts, readMethodsDraft } from "./methods-drafter.js";
import { simulateImpact } from "./impact-simulator.js";
import { runMigration } from "./migration.js";
import { assignmentRouter } from "./routes-assignment.js";
import {
  translateRule,
  replayRule,
  writeProposal,
  readProposal,
  transitionStatus,
  RuleProposal,
  listProposals,
  RuleStatus,
  ProposedEdit,
  promoteRule,
  sampleReplay,
} from "./domain/proposal/index.js";
import { loadSkillBundle, guidelineDir } from "./domain/rubric/index.js";
import { computeTaskSha } from "./lock.js";
import {
  registerCohortSamplingRoutes,
  readCohortSampling,
} from "./domain/cohort/index.js";
import { registerBuilderRoutes } from "./builder-routes.js";
import { getOrCreateBuilderSession } from "./builder-session.js";
import {
  startLockTest,
  finalizeLockTest,
  listLockTests,
  readLockTestManifest,
  writeLockTestManifest,
  type LockTestManifest,
} from "./lock-test.js";
import { listAvailablePresets } from "./agent-specs.js";
import { issueRouter } from "./adapters/http/issue-routes.js";
import { bundleRouter } from "./adapters/http/bundle-routes.js";
import { cohortRouter } from "./adapters/http/cohort-routes.js";
import { pilotRouter } from "./adapters/http/pilot-routes.js";
import { proposalRouter } from "./adapters/http/proposal-routes.js";
import { runRouter } from "./adapters/http/run-routes.js";
import { lockTestRouter } from "./adapters/http/lock-test-routes.js";
import { reviewRouter, mountDerivedAdjudicationRoutes } from "./adapters/http/review-routes.js";
import { guidelineRouter } from "./adapters/http/guideline-routes.js";
import { preflightRouter } from "./adapters/http/preflight-routes.js";
import { publicAuthRouter, protectedAuthRouter } from "./adapters/http/auth-routes.js";
import { codifyRouter } from "./adapters/http/codify-routes.js";
import {
  resolvePilotIterDirFromIterId,
  findActiveIterIdForPatient,
} from "./derived-adjudications/lock-helpers.js";

// The first compiled task we find becomes the default the chat agent
// loads as protocol context. For minimum scope we have one task
// (lung-cancer-phenotype); plumbing exists for more.
const DEFAULT_TASK_ID =
  process.env.CHART_REVIEW_TASK_ID ?? "lung-cancer-phenotype";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ?? 3001;

const app = express();
app.use(cors());
app.use(express.json());

// Serve the built client when running `npm start` (production-ish path).
app.use(express.static(path.resolve(__dirname, "../dist/client")));

// Auth endpoints (always reachable, no middleware applied) live in
// adapters/http/auth-routes.ts:publicAuthRouter().
app.use(publicAuthRouter());

// Everything below is auth-gated. In `optional` mode the middleware
// attaches reviewer_id (from token if present, else "anonymous-reviewer")
// and lets the request through. In `required` mode it 401s if no token.
app.use("/api", authMiddleware());

// Auth-gated routes (notifications + viewer-tokens) live in
// adapters/http/auth-routes.ts:protectedAuthRouter().
app.use(protectedAuthRouter());

// Reviewer-specific named endpoints (accept-draft, bulk-accept, blind-submit,
// validate, session-summary). These are mounted here so authMiddleware has
// already run and req.reviewer_id is populated.
app.use(reviewerRouter(broadcastReviewStateUpdate));

// Methods-section drafter endpoint. Each invocation persists a run-keyed
// bundle at methods/<taskId>/<run_id>/{draft.md, provenance.json} so drafts
// are durable + auditable.
app.post("/api/methods/:taskId/draft", express.json(), async (req, res) => {
  const { taskId } = req.params as { taskId: string };
  // #49 + #50 — body can include section / prior_draft / feedback /
  // prior_run_id for iterative or multi-section drafting. Empty body keeps
  // the legacy one-shot Methods behavior.
  const {
    section,
    prior_draft,
    feedback,
    prior_run_id,
  } = (req.body ?? {}) as {
    section?: string;
    prior_draft?: string;
    feedback?: string;
    prior_run_id?: string;
  };
  const validSections = ["methods", "results", "limitations", "supplement"] as const;
  if (section && !validSections.includes(section as (typeof validSections)[number])) {
    return res.status(400).json({
      ok: false,
      error: `section must be one of ${validSections.join(", ")}`,
    });
  }
  try {
    const run = await draftMethodsSection({
      taskId,
      reviewsRoot: REVIEWS_ROOT,
      section: section as (typeof validSections)[number] | undefined,
      prior_draft: typeof prior_draft === "string" ? prior_draft : undefined,
      feedback: typeof feedback === "string" ? feedback : undefined,
      prior_run_id: typeof prior_run_id === "string" ? prior_run_id : undefined,
    });
    res.json(run);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// List persisted methods drafts for a task (newest first).
app.get("/api/methods/:taskId/runs", (req, res) => {
  res.json(listMethodsDrafts(req.params.taskId));
});

// Read a specific persisted methods draft.
app.get("/api/methods/:taskId/runs/:runId", (req, res) => {
  const r = readMethodsDraft(req.params.taskId, req.params.runId);
  if (!r) return res.status(404).json({ error: "draft run not found" });
  res.json(r);
});

// Methodologist read-only routes. viewerAuthMiddleware() is applied inside
// the router; these do NOT require a reviewer session token.
app.use(methodologistRouter());

// Assignment routes (sampling, task assignment, queue management).
app.use(assignmentRouter());

// Deployment-issues queue (append + list + triage + promote-to-iter).
app.use(issueRouter());

// Reproducibility bundles (export, list, manifest, tarball download, budget).
app.use(bundleRouter());

// Deployment cohorts (G.1 → G.4: define + run + sample + validate + κ report).
app.use(cohortRouter());

// Pilot iter lifecycle (start, list, stats, eligibility, rerun-plan-preview,
// detail, critique, disagreements, adjudications, PATCH state).
app.use(pilotRouter({ onRunStatus: broadcastRunUpdate }));

// Rule proposal lifecycle (translate, submit, list, preview-diff, accept,
// reject, sample-replay).
app.use(proposalRouter());

// Batch-run primitive (start, list, manifest, status, audit, drafts, delete).
app.use(runRouter(broadcastRunUpdate));

// Lock-test (start, list, finalize, detail).
app.use(lockTestRouter());

// Review-state mutations (summary, evidence, encounters, uiactions, audit,
// actions, copilot streams).
app.use(reviewRouter({ broadcastReviewStateUpdate }));

// Post-commit feedback strip: GET endpoint for derived adjudications per patient.
mountDerivedAdjudicationRoutes(app, {
  resolvePilotIterDir: resolvePilotIterDirFromIterId,
  findActiveIterIdForPatient,
});

// Guideline meta surface (improvement, calibration, blinding, sha, maturity).
app.use(guidelineRouter());

// Author pre-flight check — GET /api/tasks/:taskId/preflight (cluster 6 — W1).
app.use(preflightRouter());

// Codify — POST /api/guideline-codify/:taskId (cluster 1 — Task 9).
app.use(codifyRouter());

// Runtime info — model + key task ids — for the UI header.
app.get("/api/runtime", (_req, res) => {
  res.json({
    model: process.env.CHART_REVIEW_MODEL ?? "(default)",
    base_url: process.env.ANTHROPIC_BASE_URL ?? "(default — direct anthropic)",
    default_task_id: DEFAULT_TASK_ID,
    auth_mode: authMode(),
    reviewers: process.env.REVIEWERS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
  });
});

// Patient endpoints
app.get("/api/patients", (req, res) => {
  const taskId = typeof req.query.task_id === "string" ? req.query.task_id : null;
  const patients = listPatients();
  if (!taskId) return res.json(patients);
  // Merge per-(patient, task) review_state metadata so the UI can filter by
  // assignment. We only read assigned_to + review_status to keep the payload
  // small.
  const enriched = patients.map((p) => {
    const rsPath = path.join(REVIEWS_ROOT, p.patient_id, taskId, "review_state.json");
    if (!fs.existsSync(rsPath)) return p;
    try {
      const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
        assigned_to?: string[];
        review_status?: string;
      };
      return {
        ...p,
        assigned_to: rs.assigned_to,
        review_status: rs.review_status,
      };
    } catch {
      return p;
    }
  });
  res.json(enriched);
});

app.get("/api/patients/:id/notes", (req, res) => {
  try {
    res.json(listNotes(req.params.id));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/patients/:id/notes/:filename", (req, res) => {
  try {
    const text = readNote(req.params.id, req.params.filename);
    res.type("text/plain").send(text);
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

app.get("/api/patients/:id/structured", (req, res) => {
  try {
    res.json(readStructured(req.params.id));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/patients/:id/messages", (req, res) => {
  res.json(chatStore.getMessages(req.params.id));
});

// Task endpoints
app.get("/api/tasks", (_req, res) => {
  const tasks = listCompiledTasks().map((t) => ({
    task_id: t.task_id,
    task_type: t.task_type,
    manual_version: t.manual_version,
    field_count: t.fields.length,
    final_output: t.final_output,
  }));
  res.json(tasks);
});

app.get("/api/tasks/:id", (req, res) => {
  const t = loadCompiledTask(req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  res.json(t);
});

app.get("/api/versions/:taskId", (req, res) => {
  const { taskId } = req.params as { taskId: string };
  res.json(listVersions(taskId, REVIEWS_ROOT));
});

app.get("/api/diff/:taskId", (req, res) => {
  const { taskId } = req.params as { taskId: string };
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) {
    res.status(400).json({ ok: false, error: "from and to query params required" });
    return;
  }
  const fromTask = loadVersionedTask(taskId, from);
  const toTask = loadVersionedTask(taskId, to);
  if (!fromTask || !toTask) {
    res.status(404).json({ ok: false, error: "version not found" });
    return;
  }
  res.json(computeTaskDiff(fromTask, toTask, from, to));
});

app.post("/api/migration/:taskId/simulate", express.json(), (req, res) => {
  const { taskId } = req.params as { taskId: string };
  const { from_sha, to_sha } = req.body as { from_sha?: string; to_sha?: string };
  if (!from_sha || !to_sha) {
    res.status(400).json({ ok: false, error: "from_sha and to_sha required" });
    return;
  }
  const result = simulateImpact({ taskId, fromSha: from_sha, toSha: to_sha, reviewsRoot: REVIEWS_ROOT });
  res.json({ ok: true, ...result });
});

app.post("/api/migration/:taskId/run", express.json(), async (req, res) => {
  const { taskId } = req.params as { taskId: string };
  const { from_sha, to_sha, patient_ids, dry_run } = req.body as {
    from_sha?: string;
    to_sha?: string;
    patient_ids?: string[];
    dry_run?: boolean;
  };
  if (!from_sha || !to_sha) {
    res.status(400).json({ ok: false, error: "from_sha and to_sha required" });
    return;
  }

  let pids = patient_ids;
  if (!pids) {
    const sim = simulateImpact({ taskId, fromSha: from_sha, toSha: to_sha, reviewsRoot: REVIEWS_ROOT });
    pids = sim.affected.map((a) => a.patient_id);
  }

  if (dry_run) {
    res.json({ ok: true, dry_run: true, would_migrate: pids });
    return;
  }

  const triggered_by = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";
  const result = await runMigration({
    taskId, fromSha: from_sha, toSha: to_sha,
    patientIds: pids, reviewsRoot: REVIEWS_ROOT, triggeredBy: triggered_by,
  });
  res.json({ ok: true, ...result });
});

// proposal routes (translate, submit, list, preview-diff, accept, reject,
// sample-replay) live in adapters/http/proposal-routes.ts.

// Review GET + copilot stream routes (suggest-override-reason +/stream,
// prelock-summary +/stream) live in adapters/http/review-routes.ts.

// blinding route lives in adapters/http/guideline-routes.ts (mounted above).

// Role A — Authoring agent. Drafts a guideline package from a research
// objective + optional references. Streaming variant via #17 jobs:
// returns a job_id synchronously and runs the agent in the background;
// the UI subscribes to WS `agent_job_update` events for progress and
// polls GET /api/jobs/<id> for the final status.
app.post("/api/authoring/draft", async (req, res) => {
  const reviewerId = reviewerIdOf(req);
  const { task_id, objective, references } = req.body ?? {};
  if (!task_id || !objective) {
    return res.status(400).json({ error: "task_id and objective required" });
  }
  try {
    const { job_id } = startDraftJob(
      { task_id, objective, references, started_by: reviewerId },
      (jid) => broadcastJobUpdate(jid),
    );
    res.json({ job_id });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── jobs (#17 streaming primitive) ───────────────────────────────────────────
app.get("/api/jobs", (req, res) => {
  const kind = typeof req.query.kind === "string" ? req.query.kind as any : undefined;
  const taskId = typeof req.query.task_id === "string" ? req.query.task_id : undefined;
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  res.json(listJobs({ kind, task_id: taskId, limit }));
});

app.get("/api/jobs/:jobId", (req, res) => {
  const m = getJobManifest(req.params.jobId);
  const s = getJobStatus(req.params.jobId);
  if (!m || !s) return res.status(404).json({ error: "job not found" });
  res.json({ manifest: m, status: s });
});

app.get("/api/jobs/:jobId/transcript", (req, res) => {
  const sinceLine = typeof req.query.since === "string" ? parseInt(req.query.since, 10) : 0;
  res.json(readJobTranscript(req.params.jobId, { sinceLine: isNaN(sinceLine) ? 0 : sinceLine }));
});

app.get("/api/authoring/drafts", (_req, res) => {
  res.json(listDrafts());
});

app.get("/api/authoring/drafts/:taskId", (req, res) => {
  const content = readDraft(req.params.taskId);
  if (content === null)
    return res.status(404).json({ error: "draft not found" });
  res.type("text/markdown").send(content);
});

// Promote a draft to a live guideline by copying
// .claude/skills/drafts/chart-review-<task_id>/ → guidelines/<task_id>/.
// Refuses to overwrite an existing live guideline unless force:true.
app.post("/api/authoring/promote/:taskId", (req, res) => {
  const force = req.body?.force === true;
  try {
    const result = promoteDraft({ task_id: req.params.taskId, force });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Builder feature — interactive guideline construction sessions.
registerBuilderRoutes(app);

// Role C — Feedback agent. Reads every review_state.json for one task,
// proposes protocol revisions, writes cohorts/<task_id>/feedback.json.
app.post("/api/cohort/analyze", async (req, res) => {
  const { task_id, member_ids } = req.body ?? {};
  if (!task_id) return res.status(400).json({ error: "task_id required" });
  try {
    const result = await analyzeCohort({ task_id, member_ids });
    res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/cohort/:taskId/feedback", (req, res) => {
  const fb = loadCohortFeedback(req.params.taskId);
  if (fb === null)
    return res.status(404).json({ error: "no feedback yet for this task" });
  res.json(fb);
});

// List persisted chart-review-cohort runs (newest first).
app.get("/api/cohort/:taskId/runs", (req, res) => {
  res.json(listFeedbackCohortRuns(req.params.taskId));
});

// Convert a chart-review-cohort proposal into a structured rule proposal so it
// enters the standard rule pipeline (RulesPanel → accept → rule-promote).
// Reads the proposal prose from the named cohort run, calls the existing
// translateRule pipeline (LLM prose → structured ProposedEdit), runs replay,
// persists the proposal, and transitions to pending_methodologist_review.
app.post("/api/cohort/:taskId/runs/:runId/proposals/:proposalId/convert", express.json(), async (req, res) => {
  const reviewerId = reviewerIdOf(req);
  const { taskId, runId, proposalId } = req.params as { taskId: string; runId: string; proposalId: string };

  const run = readCohortRun(taskId, runId) as { proposals?: Array<{
    proposal_id: string;
    category?: string;
    target_field?: string | string[] | null;
    proposal: string;
    rationale?: string;
    motivating_patients?: string[];
  }> } | null;
  if (!run) return res.status(404).json({ ok: false, error: "cohort run not found" });
  const cp = run.proposals?.find((p) => p.proposal_id === proposalId);
  if (!cp) return res.status(404).json({ ok: false, error: "proposal not found in this run" });

  let bundle;
  try { bundle = loadSkillBundle(taskId); }
  catch (e) { return res.status(404).json({ ok: false, error: `bundle not found: ${(e as Error).message}` }); }

  // Build nl_rule from the cohort proposal. Include the target_field hint
  // and category so the translator has the same context the methodologist
  // would have when authoring by hand.
  const targetFieldHint = cp.target_field
    ? Array.isArray(cp.target_field)
      ? `target_field: ${cp.target_field.join(", ")}\n`
      : `target_field: ${cp.target_field}\n`
    : "";
  const categoryHint = cp.category ? `category: ${cp.category}\n` : "";
  const rationale = cp.rationale ? `\n\nRationale: ${cp.rationale}` : "";
  const motivating = cp.motivating_patients?.length
    ? `\n\nMotivating patients: ${cp.motivating_patients.join(", ")}`
    : "";
  const nlRule = `${categoryHint}${targetFieldHint}\n${cp.proposal}${rationale}${motivating}`.trim();

  const ruleId = `rule-${new Date().toISOString().slice(0, 10)}-from-${proposalId}`;
  const tx = await translateRule({ bundle, nl_rule: nlRule });
  if (!tx.ok) {
    return res.json({ ok: false, error: tx.error, rule_id: ruleId });
  }

  const fromSha = computeTaskSha(guidelineDir(taskId));
  const replay = await replayRule({ taskId, fromSha, edit: tx.edit, reviewsRoot: REVIEWS_ROOT });

  const proposal: RuleProposal = {
    rule_id: ruleId,
    task_id: taskId,
    field_id: tx.edit.field_id,
    status: "draft",
    created_at: new Date().toISOString(),
    created_by: reviewerId,
    nl_rule: nlRule,
    proposed_edit: tx.edit,
    replay,
    trigger: { type: "cohort_feedback", run_id: runId, source_proposal_id: proposalId } as any,
  };
  writeProposal(proposal);
  const submitted = transitionStatus(taskId, ruleId, "pending_methodologist_review");
  res.json({ ok: true, proposal: submitted });
});

// Read a specific chart-review-cohort run.
app.get("/api/cohort/:taskId/runs/:runId", (req, res) => {
  const fb = readCohortRun(req.params.taskId, req.params.runId);
  if (fb === null) return res.status(404).json({ error: "run not found" });
  res.json(fb);
});

// guideline-improvement + guideline-calibration routes live in
// adapters/http/guideline-routes.ts (mounted above).

// ── batch-run primitive (#9) ─────────────────────────────────────────────────
// Drives the chart-review skill across N patients. Writes side-channel
// drafts under runs/<run_id>/ — never touches reviews/<pid>/<task>/.

function broadcastRunUpdate(status: RunStatus): void {
  // Side-effect: when a pilot's batch run terminates, flip the iter from
  // "running" → "ready_to_validate". Without this the iter manifest gets
  // stuck on "running" forever. Best-effort, never blocks the broadcast.
  maybeAutoAdvancePilotOnRunStatus(status.run_id, status.state);

  const payload = JSON.stringify({ type: "agent_run_update", run_id: status.run_id, status });
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    try { ws.send(payload); } catch { /* best-effort */ }
  }
}

/** Broadcast a streaming-job update — fired after every transcript append
 *  and after the final state transition. Carries the latest status +
 *  manifest snapshot; the UI fetches the full transcript on demand. */
function broadcastJobUpdate(jobId: string): void {
  const status = getJobStatus(jobId);
  const manifest = getJobManifest(jobId);
  if (!status || !manifest) return;
  const payload = JSON.stringify({
    type: "agent_job_update",
    job_id: jobId,
    status,
    manifest,
  });
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    try { ws.send(payload); } catch { /* best-effort */ }
  }
}

// /api/runs/* routes (start, list, manifest, status, audit, drafts, delete)
// live in adapters/http/run-routes.ts. Note: /api/runs/:runId/patients/
// :patientId/import stays inline below — it is a review-import action.

// ── cohort sampling (#T2) ────────────────────────────────────────────────────
// GET/PUT /api/cohort-sampling/:taskId — persist dev/lock cohort definitions
// alongside guideline artifacts in guidelines/<task_id>/sampling.json.

registerCohortSamplingRoutes(app);

// deployment-cohort routes (G.1–G.4 + κ report) live in
// adapters/http/cohort-routes.ts, mounted via cohortRouter() above.

// deployment-issues routes (POST/GET, triage, promote-to-iter) live in
// adapters/http/issue-routes.ts and are mounted via issueRouter() above.

// ── agent roles registry ─────────────────────────────────────────────────────
app.get("/api/agent-roles", (_req, res) => {
  const presets = listAvailablePresets().map((p) => ({
    preset_id: p.preset_id,
    preset_version: p.preset_version,
    axis: p.axis ?? null,
    role_prompt: p.role_prompt,
  }));
  res.json({ presets });
});

app.get("/api/agent-roles/default-model", (_req, res) => {
  res.json({ default_model: process.env.CHART_REVIEW_MODEL ?? null });
});

// pilot iterations routes (start, list, stats, eligibility,
// rerun-plan-preview, detail) live in adapters/http/pilot-routes.ts.

// reproducibility bundle export + budget routes live in
// adapters/http/bundle-routes.ts and are mounted via bundleRouter() above.

// guideline sha + maturity routes live in
// adapters/http/guideline-routes.ts (mounted above).

// pilot critique + disagreements + adjudications + PATCH state routes
// live in adapters/http/pilot-routes.ts.

// Import an agent draft from a run into reviews/<pid>/<task>/review_state.json.
// The draft is the agent's first-pass; the reviewer then validates per-criterion
// in the normal review UI. Refuses to overwrite an existing review_state or
// import across guideline-SHA drift unless force:true.
app.post("/api/runs/:runId/patients/:patientId/import", (req, res) => {
  const { runId, patientId } = req.params;
  const reviewerId = reviewerIdOf(req);
  const force = req.body?.force === true;

  const manifest = getRunManifest(runId);
  if (!manifest) return res.status(404).json({ error: "run not found" });

  const draft = readRunDraft(runId, patientId);
  if (!draft) return res.status(404).json({ error: "draft not found for this patient in this run" });

  const taskId = manifest.task_id;
  const reviewStatePath = path.join(REVIEWS_ROOT, patientId, taskId, "review_state.json");

  if (fs.existsSync(reviewStatePath) && !force) {
    return res.status(409).json({
      ok: false,
      error: "review_state already exists for this patient×task; pass force:true to overwrite",
    });
  }

  // Drift check: if the live guideline SHA has moved since the run, refuse
  // unless explicitly forced. Importing across drift would silently land
  // assessments produced against an older criterion definition.
  let currentSha: string | null = null;
  try { currentSha = computeTaskSha(guidelineDir(taskId)); } catch { /* missing guideline */ }
  if (currentSha && currentSha !== manifest.guideline_sha && !force) {
    return res.status(409).json({
      ok: false,
      error: "guideline SHA changed since this run; pass force:true to import anyway",
      run_sha: manifest.guideline_sha,
      current_sha: currentSha,
    });
  }

  fs.mkdirSync(path.dirname(reviewStatePath), { recursive: true });
  fs.writeFileSync(reviewStatePath, JSON.stringify(draft, null, 2));

  // Audit entry under a synthetic session keyed by the run, so the
  // provenance ("imported from run X") is preserved alongside the
  // chat / reviewer audit trails.
  const sessionId = `import-${runId}`;
  appendAuditEntry(
    { patientId, taskId, sessionId },
    {
      ts: new Date().toISOString(),
      session_id: sessionId,
      step_type: "ui_action",
      action_type: "draft_import",
      source: "reviewer",
      payload_summary: `import agent_draft from run ${runId}`,
      run_id: runId,
      reviewer_id: reviewerId,
    } as any,
  );

  res.json({ ok: true, review_state_path: reviewStatePath, run_id: runId });
});

// applyReviewerAction + handleReviewerError helpers were used only by the
// review-state mutation routes that now live in adapters/http/review-routes.ts.
// The router holds its own copies (closing over its broadcast callback).


// QA stats endpoint — aggregates field assessment metrics across all patients for a task.
app.get("/api/qa/:taskId", async (req, res) => {
  const { taskId } = req.params as { taskId: string };
  try {
    const stats = await computeQAStats(taskId, REVIEWS_ROOT);
    res.json(stats);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Review-state mutations (DELETE, summary, evidence, encounters, uiactions,
// audit, actions) live in adapters/http/review-routes.ts (mounted above).

// lock-test routes (start, list, finalize, detail) live in
// adapters/http/lock-test-routes.ts.

// Per-(patient, task, blindMode) sessions are started lazily when a client subscribes.
// Two reviewers can review different tasks on the same patient concurrently
// (or vice versa) — each (patient_id, task_id) gets its own session.
// blindMode is included in the key so a normal-review session and a blind-mode
// session for the same (patientId, taskId) are always distinct cache entries.
const sessions: Map<string, Session> = new Map();
function sessionKey(patientId: string, taskId: string, blindMode?: boolean): string {
  return `${patientId}::${taskId}::${blindMode ? "blind" : "normal"}`;
}
function getOrCreateSession(patientId: string, taskId: string, blindMode?: boolean): Session {
  const key = sessionKey(patientId, taskId, blindMode);
  let session = sessions.get(key);
  if (!session) {
    const task = loadCompiledTask(taskId);
    session = new Session(patientId, task, blindMode);
    sessions.set(key, session);
  }
  return session;
}

/**
 * Broadcast a review-state update to every WS client subscribed to that
 * (patient, task). Defaults to DEFAULT_TASK_ID when called from reviewer
 * REST endpoints that don't yet thread taskId — those endpoints already
 * receive taskId in the URL, so they pass it through.
 */
function broadcastReviewStateUpdate(
  patientId: string,
  state: ReviewState,
  taskId: string = DEFAULT_TASK_ID,
): void {
  // Broadcasts originate from REST annotator endpoints, which are never blind-mode.
  const session = sessions.get(sessionKey(patientId, taskId, false));
  if (!session) return;
  for (const ws of (session as any).subscribers as Set<WSClient>) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(
      JSON.stringify({
        type: "review_state_update",
        patientId,
        taskId,
        state,
      }),
    );
  }
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WSClient, req) => {
  // Resolve the reviewer_id from a `?token=…` query param on the
  // upgrade URL. In `optional` mode missing/invalid tokens become
  // "anonymous-reviewer"; in `required` mode they get the connection
  // closed with a code.
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const token = url.searchParams.get("token");
  const reviewerId = resolveToken(token);
  if (authMode() === "required" && !reviewerId) {
    ws.close(4401, "unauthenticated");
    return;
  }
  ws.reviewer_id = reviewerId ?? "anonymous-reviewer";
  ws.isAlive = true;
  ws.send(
    JSON.stringify({
      type: "connected",
      message: "ready",
      reviewer_id: ws.reviewer_id,
    }),
  );

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg: IncomingWSMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid JSON" }));
      return;
    }

    // Validate + wrap so a bad message can never crash the server. Before
    // this, any WS message missing patientId would call patientDir(undefined),
    // throw inside the handler, escape to the Node process, and kill the
    // whole server — every subsequent request would ECONNREFUSED.
    try {
      switch (msg.type) {
        case "subscribe":
        case "chat": {
          if (typeof msg.patientId !== "string" || msg.patientId.length === 0) {
            ws.send(
              JSON.stringify({
                type: "error",
                error: `${msg.type} message requires a non-empty patientId`,
              }),
            );
            return;
          }
          const taskId = msg.taskId ?? DEFAULT_TASK_ID;
          const session = getOrCreateSession(msg.patientId, taskId, msg.blindMode);
          session.subscribe(ws);
          if (msg.type === "subscribe") {
            ws.send(
              JSON.stringify({
                type: "history",
                patientId: msg.patientId,
                taskId,
                messages: chatStore.getMessages(msg.patientId),
              }),
            );
          } else {
            session.sendMessage(msg.content);
          }
          break;
        }
        default:
          ws.send(JSON.stringify({ type: "error", error: "unknown message type" }));
      }
    } catch (e) {
      console.error("[ws] message handler threw:", (e as Error).message);
      try {
        ws.send(
          JSON.stringify({
            type: "error",
            error: `server error: ${(e as Error).message}`,
          }),
        );
      } catch {
        /* socket already gone */
      }
    }
  });

  ws.on("close", () => {
    for (const session of sessions.values()) session.unsubscribe(ws);
  });
});

// Builder WebSocket endpoint: /api/builder/sessions/:taskId/stream
const wssBuilder = new WebSocketServer({ noServer: true });

wssBuilder.on("connection", (ws: WSClient, req) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const token = url.searchParams.get("token");
  const reviewerId = resolveToken(token) ?? "anonymous-reviewer";

  const builderMatch = url.pathname.match(/^\/api\/builder\/sessions\/([^/]+)\/stream$/);
  if (!builderMatch) {
    ws.close(4404, "not found");
    return;
  }

  const taskId = builderMatch[1];
  const session = getOrCreateBuilderSession(taskId, reviewerId);
  session.subscribe(ws as any);

  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "user_message" && typeof msg.content === "string") {
      session.sendUserMessage(msg.content);
    }
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  if (/^\/api\/builder\/sessions\/[^/]+\/stream$/.test(url.pathname)) {
    wssBuilder.handleUpgrade(req, socket as any, head, (ws) => {
      wssBuilder.emit("connection", ws, req);
    });
  } else if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket as any, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((c) => {
    const ws = c as WSClient;
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);
wss.on("close", () => clearInterval(heartbeat));

// Process-level safety net. Without these, any uncaught exception in any
// async handler (WS, route, agent stream) takes the whole Node process down
// and every subsequent request gets ECONNREFUSED. We log and stay alive.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

server.listen(PORT, () => {
  // Warn if any legacy .claude/skills/drafts/chart-review-*/ directories exist.
  // These should have been migrated by `npm run migrate-drafts`. The skill loader
  // no longer scans drafts/ — draft state is represented by `status: draft` in
  // meta.yaml at the live path .claude/skills/chart-review-<id>/.
  const legacyDraftsRoot = path.join(
    process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT,
    ".claude", "skills", "drafts",
  );
  if (fs.existsSync(legacyDraftsRoot)) {
    const legacyDraftDirs = fs.readdirSync(legacyDraftsRoot).filter((name) => {
      if (!name.startsWith("chart-review-")) return false;
      const full = path.join(legacyDraftsRoot, name);
      return fs.statSync(full, { throwIfNoEntry: false })?.isDirectory() ?? false;
    });
    if (legacyDraftDirs.length > 0) {
      console.error(
        `[startup] WARNING: ${legacyDraftDirs.length} legacy draft skill(s) found under ` +
        `.claude/skills/drafts/. The skill loader no longer reads from that path. ` +
        `Run \`npm run migrate-drafts\` from chart-review-platform/app/ to migrate them. ` +
        `Directories: ${legacyDraftDirs.join(", ")}`,
      );
    }
  }

  // Catch up any pilot iters whose runs already terminated while the server
  // was offline (e.g. seed data, legacy iters never advanced through the UI).
  reconcilePilotStatesOnStartup();

  const t = loadCompiledTask(DEFAULT_TASK_ID);
  console.log(`chart-review listening on http://localhost:${PORT}`);
  console.log(`(dev) frontend served by Vite at http://localhost:5173`);
  console.log(`WebSocket at ws://localhost:${PORT}/ws`);
  console.log(
    `default task: ${DEFAULT_TASK_ID} ${t ? `(loaded — ${t.fields.length} fields)` : "(NOT FOUND — agent will run without protocol context)"}`,
  );
});
