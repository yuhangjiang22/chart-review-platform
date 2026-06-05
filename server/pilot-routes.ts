// M2 — Pilot iteration routes ported from v1's pilot-routes.ts.
//
// All routes (GET + POST + PATCH) covering v1's pilot + versions
// surface. Each handler is a thin wrapper around v1's exported
// domain functions. v2 owns the route surface; v1 still owns the
// heavy lifting (listPilotIterations, startPilotIteration,
// selfCritiquePilot, …) until a later milestone vendors the source.
// Same trade we made for runAgent, compareDrafts, judgeCell.

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";

// v1 imports (still — vendored copy comes in a later milestone)
import {
  listPilotIterations,
  getPilotManifest,
  getPilotCritique,
  pilotIterationStats,
  startPilotIteration,
  selfCritiquePilot,
  setPilotState,
  fireAutoCritique,
  transitionIterToRevising,
  computeIterAccuracy,
  persistIterAccuracy,
  writeIterReport,
  readPrimaryCriterionIds,
  maybeAutoAdvancePilotOnRunStatus,
  getSessionManifest,
  type PilotState,
} from "./lib/domain/iter/index.js";
import type { RunStatus } from "./lib/infra/batch-run/index.js";
import { evaluateStopRule } from "./lib/domain/iter/stop-rule.js";
import { extractDisagreements } from "./lib/domain/iter/pilots.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { loadCriteria, guidelineDir, phenotypeSkillDir } from "./lib/domain/rubric/index.js";
import { readCohortSampling } from "./lib/domain/cohort/index.js";
import {
  writeAdjudication, listAdjudications, type Adjudication,
} from "./lib/adjudications.js";
import {
  criterionSchemaHash, computeRerunPlan,
} from "./lib/criterion-hash.js";
import { computeEligibility, type IterSnapshot } from "./lib/eligibility.js";
import {
  getRunManifest, getRunStatus,
} from "./lib/infra/batch-run/index.js";
import {
  readJudgeAnalyses, isJudgeBatchRunning, runJudgeBatch, runJudgeSpanBatch,
  lockJudgeBatch, unlockJudgeBatch,
} from "./lib/judge-batch.js";
import {
  computeRevisitsForIter, bulkKeepRevisits,
} from "./lib/derived-adjudications/revisits.js";

/** Throw a methodologist-only 403 (or 401 in required-auth mode) when
 *  the caller can't run this endpoint. Inline because the parameterized
 *  router uses a different handler signature than v2's exact-match
 *  routes — so auth.ts's `requireMethodologist` wrapper doesn't apply
 *  directly. */
function gateMethodologist(req: Parameters<RouteEntry["handler"]>[1], action: string): string {
  const reviewerId = readReviewerFromRequest(req);
  if (reviewerId === null) {
    const err = new Error("Authorization required. POST /api/auth/login first.") as Error & { status: number };
    err.status = 401;
    throw err;
  }
  if (!isMethodologist(reviewerId)) {
    const err = new Error(`${action} requires methodologist privilege`) as Error & { status: number };
    err.status = 403;
    throw err;
  }
  return reviewerId;
}

/** Pilot iter auto-advance — fires when the underlying batch run terminates.
 *  Without this the iter manifest stays on "running" forever. WS broadcast
 *  to subscribed clients moves to M6.7c; the state-flip must run regardless. */
function onPilotRunStatus(status: RunStatus): void {
  maybeAutoAdvancePilotOnRunStatus(status.run_id, status.state);
}

/** v1's disagreements.json may carry pre-cluster-3 shape (flat string
 *  answers). v1's handler shims it; we do the same so clients don't
 *  need to know about the format change. */
function coerceLegacyDisagreement(d: any): any {
  if (!d?.answers) return d;
  for (const which of ["agent_a", "agent_b"] as const) {
    const v = d.answers[which];
    if (typeof v === "string") {
      d.answers[which] = { value: v, status: "answered" };
    } else if (v && typeof v === "object" && !("status" in v)) {
      d.answers[which] = { value: v.value ?? null, status: "answered" };
    }
  }
  return d;
}

export const pilotReadRoutes: RouteEntry[] = [
  // ── /api/pilots/:taskId ──────────────────────────────────────────
  {
    method: "GET", pattern: "/api/pilots/:taskId",
    handler: async (_b, _r, p) => listPilotIterations(p.taskId),
  },

  // /stats and /eligibility must precede /:iterId so the path matcher
  // hits them as literal segments, not as iter ids.
  {
    method: "GET", pattern: "/api/pilots/:taskId/stats",
    handler: async (_b, _r, p) => pilotIterationStats(p.taskId),
  },

  {
    method: "GET", pattern: "/api/pilots/:taskId/eligibility",
    handler: async (_b, _r, p) => {
      const pilots = listPilotIterations(p.taskId);
      const iters: IterSnapshot[] = pilots
        .filter((x) => x.state === "complete")
        .map((x) => {
          const full = getPilotCritique(p.taskId, x.iter_id);
          const acc = (full as any)?.accuracy;
          if (!acc) return null;
          return { iter_id: x.iter_id, per_criterion: acc.per_criterion, override_count: acc.override_count };
        })
        .filter((x): x is IterSnapshot => x !== null)
        .sort((a, b) => a.iter_id.localeCompare(b.iter_id));
      return computeEligibility(iters);
    },
  },

  {
    method: "GET", pattern: "/api/pilots/:taskId/rerun-plan-preview",
    handler: async (_b, _r, p) => {
      const taskId = p.taskId;
      const criteria = loadCriteria(taskId);
      const currentHashes: Record<string, string> = {};
      for (const c of criteria) {
        if ((c as any).derivation != null) continue;
        currentHashes[c.field_id] = c.schema_hash ?? criterionSchemaHash(c as Record<string, unknown>);
      }
      const allIters = listPilotIterations(taskId);
      const priorIter = allIters.length > 0 ? allIters[0] : null;
      const priorManifest = priorIter
        ? { iter_id: priorIter.iter_id, criterion_schema_hashes: priorIter.criterion_schema_hashes }
        : null;
      const plan = computeRerunPlan(currentHashes, priorManifest);
      const COST_PER_CELL_USD = 0.034;
      let nPatients = 5;
      try {
        const cohort = readCohortSampling(taskId);
        if (cohort?.dev_patient_ids?.length) nPatients = cohort.dev_patient_ids.length;
      } catch { /* ignore */ }
      const nRerun = plan.rerun_criteria.length;
      const estimatedCostPerAgent =
        nRerun > 0 ? +(nRerun * nPatients * COST_PER_CELL_USD).toFixed(2) : 0;
      const costBasis = nRerun === 0
        ? "no agent runs needed (all criteria carry over)"
        : `${nPatients} patients x ${nRerun} criteria x $${COST_PER_CELL_USD}/cell (haiku-4.5 baseline)`;
      return {
        task_id: taskId,
        prior_iter_id: priorIter?.iter_id ?? null,
        prior_had_criterion_hashes: priorManifest?.criterion_schema_hashes != null,
        carried_criteria: plan.carried_criteria,
        rerun_criteria: plan.rerun_criteria,
        estimated_cost_usd_per_agent: estimatedCostPerAgent,
        estimated_cost_basis: costBasis,
        n_patients: nPatients,
      };
    },
  },

  {
    method: "GET", pattern: "/api/pilots/:taskId/stop-rule",
    handler: async (_b, _r, p) => evaluateStopRule({ taskId: p.taskId }),
  },

  // ── /api/pilots/:taskId/:iterId/* ────────────────────────────────
  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId",
    handler: async (_b, _r, p) => {
      const { taskId, iterId } = p;
      const m = getPilotManifest(taskId, iterId);
      if (!m) {
        const err = new Error("pilot iteration not found") as Error & { status: number };
        err.status = 404;
        throw err;
      }
      const critique = getPilotCritique(taskId, iterId);
      const platformRoot =
        process.env.CHART_REVIEW_PLATFORM_ROOT
        ?? path.resolve(process.cwd(), "..", "chart-review-platform");
      const reviewsRootDir =
        process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(platformRoot, "var", "reviews");
      const runManifest = getRunManifest(m.run_id);
      const runStatus = getRunStatus(m.run_id);
      const patientIds: string[] =
        runManifest?.patient_ids
        ?? readCohortSampling(taskId)?.dev_patient_ids
        ?? [];
      const patient_status = patientIds.map((pid) => {
        const perPatient = runStatus?.per_patient?.[pid];
        const agentDone = perPatient?.state === "complete";
        const errored = perPatient?.state === "error";
        const errorMessage = errored ? (perPatient?.error ?? null) : null;
        const reviewPath = path.join(reviewsRootDir, pid, taskId, "review_state.json");
        let validated = false;
        let reviewerTouched = false;
        if (fs.existsSync(reviewPath)) {
          try {
            const state = JSON.parse(fs.readFileSync(reviewPath, "utf8")) as {
              review_status?: string;
              field_assessments?: Array<{ source?: string }>;
            };
            validated =
              state.review_status === "reviewer_validated"
              || state.review_status === "locked";
            reviewerTouched = (state.field_assessments ?? []).some((fa) => fa.source === "reviewer");
          } catch { /* ignore */ }
        }
        return {
          patient_id: pid, agent_done: agentDone, oracle_done: validated,
          in_progress: reviewerTouched && !validated,
          errored, error_message: errorMessage,
        };
      });
      return { manifest: m, critique, patient_status };
    },
  },

  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId/critique",
    handler: async (_b, _r, p) => getPilotCritique(p.taskId, p.iterId),
  },

  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId/disagreements",
    handler: async (_b, _r, p) => {
      const fp = path.join(guidelineDir(p.taskId), "pilots", p.iterId, "disagreements.json");
      if (fs.existsSync(fp)) {
        const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
        return {
          ...raw,
          disagreements: Array.isArray(raw.disagreements)
            ? raw.disagreements.map(coerceLegacyDisagreement)
            : [],
        };
      }
      return extractDisagreements(p.taskId, p.iterId);
    },
  },

  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId/adjudications",
    handler: async (_b, _r, p) => {
      const dir = path.join(guidelineDir(p.taskId), "pilots", p.iterId);
      return { adjudications: listAdjudications(dir) };
    },
  },

  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId/judge",
    handler: async (_b, _r, p) => {
      const file = readJudgeAnalyses(p.taskId, p.iterId);
      const running = isJudgeBatchRunning(p.taskId, p.iterId);
      if (!file) return { exists: false, running, analyses: [] };
      return { exists: true, running, ...file };
    },
  },

  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId/revisits",
    handler: async (_b, _r, p) => {
      const result = computeRevisitsForIter({ taskId: p.taskId, iterId: p.iterId });
      return { ok: true, ...result };
    },
  },
];

const ALLOWED_PILOT_STATES: PilotState[] = [
  "running", "ready_to_validate", "complete", "abandoned",
  "validating", "revising", "superseded", "locked",
];

export const pilotWriteRoutes: RouteEntry[] = [
  // POST /api/pilots/:taskId — start a new pilot iteration
  {
    method: "POST", pattern: "/api/pilots/:taskId",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "starting a pilot");
      const {
        patient_ids, notes, max_concurrency, max_turns_per_patient,
        cost_cap_usd, agent_specs, provider, model, session_id,
      } = (body ?? {}) as {
        patient_ids?: string[]; notes?: string;
        max_concurrency?: number; max_turns_per_patient?: number;
        cost_cap_usd?: number; agent_specs?: unknown;
        provider?: string; model?: string; session_id?: string;
      };
      if (!Array.isArray(patient_ids) || patient_ids.length === 0) {
        const err = new Error("non-empty patient_ids required") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      // Validate provider when set; "default" / undefined → let server
      // fall back to AGENT_PROVIDER env var.
      let resolvedProvider: "claude" | "codex" | undefined;
      if (provider && provider !== "default") {
        if (provider !== "claude" && provider !== "codex") {
          const err = new Error(`unknown provider: ${provider}`) as Error & { status: number };
          err.status = 400; throw err;
        }
        resolvedProvider = provider;
      }
      // When a session_id is passed, validate it exists + is active.
      // Iters started without a session_id remain legacy/ungrouped.
      let resolvedSessionId: string | undefined;
      if (session_id) {
        const session = getSessionManifest(p.taskId, session_id);
        if (!session) {
          const err = new Error(`session not found: ${session_id}`) as Error & { status: number };
          err.status = 400; throw err;
        }
        if (session.state !== "active") {
          const err = new Error(`session ${session_id} is archived; start a new session`) as Error & { status: number };
          err.status = 400; throw err;
        }
        resolvedSessionId = session_id;
      }
      return startPilotIteration({
        task_id: p.taskId,
        patient_ids,
        started_by: reviewerId,
        notes,
        max_concurrency,
        max_turns_per_patient,
        cost_cap_usd,
        agent_specs: agent_specs as Parameters<typeof startPilotIteration>[0]["agent_specs"],
        provider: resolvedProvider,
        model: typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined,
        session_id: resolvedSessionId,
        onRunStatus: onPilotRunStatus,
      });
    },
  },

  // POST /api/pilots/:taskId/:iterId/run-again — start a new iter on the
  // SAME cohort with the SAME agent_specs as the named iter. Used by the
  // adherence DECIDE → TRY inner loop: reviewer's persisted answers
  // already carry forward as the gold standard, so the next iter scores
  // automatically without re-validation.
  {
    method: "POST", pattern: "/api/pilots/:taskId/:iterId/run-again",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "re-running a pilot");
      const m = getPilotManifest(p.taskId, p.iterId);
      if (!m) {
        const err = new Error(`pilot ${p.iterId} not found`) as Error & { status: number };
        err.status = 404;
        throw err;
      }
      const run = getRunManifest(m.run_id);
      if (!run) {
        const err = new Error(`run ${m.run_id} not found`) as Error & { status: number };
        err.status = 404;
        throw err;
      }
      const { notes } = (body ?? {}) as { notes?: string };
      return startPilotIteration({
        task_id: p.taskId,
        patient_ids: run.patient_ids,
        started_by: reviewerId,
        notes: notes ?? `Run again on cohort from ${p.iterId}`,
        agent_specs: run.agent_specs,
        onRunStatus: onPilotRunStatus,
      });
    },
  },

  // POST /api/pilots/:taskId/:iterId/critique — self-critique + accuracy
  {
    method: "POST", pattern: "/api/pilots/:taskId/:iterId/critique",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "self-critique");
      const { focus_criterion } = (body ?? {}) as { focus_criterion?: string };
      const result = await selfCritiquePilot({
        task_id: p.taskId,
        iter_id: p.iterId,
        ran_by: reviewerId,
        focus_criterion,
      });
      // Per-iter accuracy compute — same shape as v1's handler.
      try {
        const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT
          ?? path.resolve(process.cwd(), "..", "chart-review-platform");
        const cohort = readCohortSampling(p.taskId);
        const primaryCriterionIds = readPrimaryCriterionIds(p.taskId);
        if (cohort && primaryCriterionIds.length > 0) {
          const accuracy = computeIterAccuracy({
            rootDir: platformRoot,
            taskId: p.taskId,
            iterId: p.iterId,
            cohortKind: "dev",
            patientIds: cohort.dev_patient_ids,
            primaryCriterionIds,
          });
          persistIterAccuracy(p.taskId, p.iterId, accuracy);
          writeIterReport(p.taskId, p.iterId, accuracy);
        }
      } catch (err) {
        console.error(`[refinement-loop] accuracy compute failed for ${p.taskId}/${p.iterId}:`, err);
      }
      return result;
    },
  },

  // POST /api/pilots/:taskId/:iterId/judge — start judge batch (async)
  {
    method: "POST", pattern: "/api/pilots/:taskId/:iterId/judge",
    handler: async (_body, req, p) => {
      const reviewerId = gateMethodologist(req, "running judge");
      if (isJudgeBatchRunning(p.taskId, p.iterId)) {
        const err = new Error("judge batch already running for this iter") as Error & { status: number };
        err.status = 409;
        throw err;
      }
      if (!lockJudgeBatch(p.taskId, p.iterId)) {
        const err = new Error("could not acquire judge batch lock") as Error & { status: number };
        err.status = 409;
        throw err;
      }
      // task_kind dispatch — phenotype tasks judge cells, NER tasks
      // judge spans. Both write to the same judge_analyses.json file
      // (the schema carries a `task_kind` discriminator).
      const task = loadCompiledTask(p.taskId);
      const runner = task?.task_kind === "ner" ? runJudgeSpanBatch : runJudgeBatch;
      const label = task?.task_kind === "ner" ? "judge-batch-ner" : "judge-batch";
      void runner({
        taskId: p.taskId,
        iterId: p.iterId,
        startedBy: reviewerId,
      })
        .then((result) => {
          console.log(
            `[${label}] ${p.taskId}/${p.iterId} done: ${result.cells_analyzed}/${result.cells_total} cells, ` +
            `$${result.total_cost_usd.toFixed(4)}, ${result.total_duration_ms}ms`,
          );
        })
        .catch((e) => {
          console.error(`[${label}] ${p.taskId}/${p.iterId} failed:`, e);
        })
        .finally(() => {
          unlockJudgeBatch(p.taskId, p.iterId);
        });
      return { ok: true, started: true, taskId: p.taskId, iterId: p.iterId };
    },
  },

  // POST /api/pilots/:taskId/:iterId/adjudications — append adjudication
  {
    method: "POST", pattern: "/api/pilots/:taskId/:iterId/adjudications",
    handler: async (body, _req, p) => {
      const dir = path.join(guidelineDir(p.taskId), "pilots", p.iterId);
      const entry = (body ?? {}) as Adjudication;
      if (!entry.timestamp) entry.timestamp = new Date().toISOString();
      writeAdjudication(dir, entry);
      return { ok: true };
    },
  },

  // POST /api/pilots/:taskId/:iterId/revisits/bulk-keep
  {
    method: "POST", pattern: "/api/pilots/:taskId/:iterId/revisits/bulk-keep",
    handler: async (body, req, p) => {
      const { field_id, patient_ids } = (body ?? {}) as {
        field_id?: string; patient_ids?: string[];
      };
      if (typeof field_id !== "string" || field_id.length === 0) {
        const err = new Error("field_id required") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const result = await bulkKeepRevisits({
        taskId: p.taskId,
        fieldId: field_id,
        patientIds: Array.isArray(patient_ids) ? patient_ids : undefined,
        reviewerId,
      });
      return { ok: true, ...result };
    },
  },

  // PATCH /api/pilots/:taskId/:iterId — update state/notes; auto-critique on complete
  {
    method: "PATCH", pattern: "/api/pilots/:taskId/:iterId",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "updating a pilot");
      const { state, notes } = (body ?? {}) as { state?: PilotState; notes?: string };
      if (state && !ALLOWED_PILOT_STATES.includes(state)) {
        const err = new Error(`state must be one of ${ALLOWED_PILOT_STATES.join(", ")}`) as Error & { status: number };
        err.status = 400;
        throw err;
      }
      try {
        const updated = setPilotState(p.taskId, p.iterId, (state ?? "running") as PilotState, notes);
        if (state === "complete") {
          fireAutoCritique(p.taskId, p.iterId, reviewerId);
        }
        return updated;
      } catch (e) {
        const err = new Error((e as Error).message) as Error & { status: number };
        err.status = 404;
        throw err;
      }
    },
  },
];

// ── /api/versions/* aliases — see v1 pilot-routes.ts ──────────────────
// Same store as /api/pilots/*, different label (versions == iters with a
// vTag). Kept distinct so the UI can use the cleaner /api/versions/*
// surface going forward.
export const versionsRoutes: RouteEntry[] = [
  {
    method: "GET", pattern: "/api/versions/:taskId",
    handler: async (_b, _r, p) => listPilotIterations(p.taskId),
  },
  {
    method: "GET", pattern: "/api/versions/:taskId/:vTag",
    handler: async (_b, _r, p) => {
      const m = getPilotManifest(p.taskId, p.vTag);
      if (!m) {
        const err = new Error("iter not found") as Error & { status: number };
        err.status = 404;
        throw err;
      }
      const critique = getPilotCritique(p.taskId, p.vTag);
      return { manifest: m, critique };
    },
  },
  {
    method: "GET", pattern: "/api/versions/:taskId/:vTag/revisits",
    handler: async (_b, _r, p) => {
      const result = computeRevisitsForIter({ taskId: p.taskId, iterId: p.vTag });
      return { ok: true, ...result };
    },
  },
  {
    method: "GET", pattern: "/api/versions/:taskId/:vTag/cells",
    handler: async (_b, _r, p) => {
      const manifest = getPilotManifest(p.taskId, p.vTag);
      if (!manifest) {
        const err = new Error(`iter not found: ${p.vTag}`) as Error & { status: number };
        err.status = 404;
        throw err;
      }
      const cohort = readCohortSampling(p.taskId);
      const patientIds: string[] =
        (manifest as any).patient_sample
        ?? cohort?.dev_patient_ids
        ?? [];
      const criteriaHashes = manifest.criterion_schema_hashes ?? {};
      const fieldIds = Object.keys(criteriaHashes);
      const { rows: revisitRows } = computeRevisitsForIter({ taskId: p.taskId, iterId: p.vTag });
      const staleKey = (pid: string, fid: string) => `${pid}__${fid}`;
      const staleSet = new Set(revisitRows.map((r) => staleKey(r.patient_id, r.field_id)));
      const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT
        ?? path.resolve(process.cwd(), "..", "chart-review-platform");
      const reviewsRootDir = process.env.CHART_REVIEW_REVIEWS_ROOT
        ?? path.join(platformRoot, "var", "reviews");
      const cells: Array<{
        patient_id: string;
        field_id: string;
        state: "fresh" | "stale" | "unvalidated";
        reviewer_answer?: unknown;
        captured_against_schema_hash?: string;
      }> = [];
      for (const patientId of patientIds) {
        const reviewerAssessments: Record<string, {
          answer?: unknown;
          captured_against_schema_hash?: string;
        }> = {};
        try {
          const rsPath = path.join(reviewsRootDir, patientId, p.taskId, "review_state.json");
          if (fs.existsSync(rsPath)) {
            const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
              field_assessments?: Array<{
                field_id: string; source: string; answer?: unknown;
                captured_against_schema_hash?: string;
              }>;
            };
            for (const fa of rs.field_assessments ?? []) {
              if (fa.source === "reviewer") {
                reviewerAssessments[fa.field_id] = {
                  answer: fa.answer,
                  captured_against_schema_hash: fa.captured_against_schema_hash,
                };
              }
            }
          }
        } catch { /* best-effort */ }
        for (const fieldId of fieldIds) {
          const isStale = staleSet.has(staleKey(patientId, fieldId));
          const reviewerRec = reviewerAssessments[fieldId];
          const currentHash = criteriaHashes[fieldId];
          let cellState: "fresh" | "stale" | "unvalidated";
          if (isStale) cellState = "stale";
          else if (reviewerRec && reviewerRec.captured_against_schema_hash === currentHash) {
            cellState = "fresh";
          } else cellState = "unvalidated";
          cells.push({
            patient_id: patientId,
            field_id: fieldId,
            state: cellState,
            reviewer_answer: reviewerRec?.answer,
            captured_against_schema_hash: reviewerRec?.captured_against_schema_hash,
          });
        }
      }
      return { cells, total: cells.length, iter_id: p.vTag };
    },
  },
  {
    method: "POST", pattern: "/api/versions/:taskId/:vTag/revise",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "revise");
      const { criteria_edits, patient_sample_change } = (body ?? {}) as {
        criteria_edits?: Array<{ field_id: string; new_yaml: string }>;
        patient_sample_change?: { add?: string[]; remove?: string[] };
      };
      if (!Array.isArray(criteria_edits)) {
        const err = new Error("criteria_edits (array) required") as Error & { status: number };
        err.status = 422;
        throw err;
      }
      const source = getPilotManifest(p.taskId, p.vTag);
      if (!source) {
        const err = new Error(`iter not found: ${p.vTag}`) as Error & { status: number };
        err.status = 404;
        throw err;
      }
      const skillCriteriaDir = path.join(
        phenotypeSkillDir(p.taskId), "references", "criteria",
      );
      for (const edit of criteria_edits) {
        if (!edit.field_id || typeof edit.new_yaml !== "string") continue;
        const filePath = path.join(skillCriteriaDir, `${edit.field_id}.md`);
        fs.mkdirSync(skillCriteriaDir, { recursive: true });
        fs.writeFileSync(filePath, edit.new_yaml);
      }
      const updatedSource = transitionIterToRevising(p.taskId, p.vTag);
      const cohort = readCohortSampling(p.taskId);
      let patientIds: string[] = (source as any).patient_sample ?? cohort?.dev_patient_ids ?? [];
      if (patient_sample_change) {
        const remove = new Set<string>(patient_sample_change.remove ?? []);
        patientIds = patientIds.filter((pid) => !remove.has(pid));
        patientIds = Array.from(new Set([...patientIds, ...(patient_sample_change.add ?? [])]));
      }
      const startResult = startPilotIteration({
        task_id: p.taskId,
        patient_ids: patientIds,
        started_by: reviewerId,
        onRunStatus: onPilotRunStatus,
      });
      const newManifest = startResult.pilot;
      const oldHashes = (source as any).criterion_schema_hashes ?? {};
      const newHashes = (newManifest as any).criterion_schema_hashes ?? {};
      const staleCells: Array<{ patient_id: string; field_id: string }> = [];
      for (const [fieldId, newHash] of Object.entries(newHashes)) {
        if (oldHashes[fieldId] !== newHash) {
          for (const pid of patientIds) {
            staleCells.push({ patient_id: pid, field_id: fieldId });
          }
        }
      }
      return {
        new_version_tag: newManifest.iter_id,
        stale_cells: staleCells,
        source_iter_state: updatedSource.state,
      };
    },
  },
];
