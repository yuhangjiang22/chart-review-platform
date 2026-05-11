// M4 — Cohort routes ported from v1's cohort-routes.ts.
//
// 12 endpoints under /api/cohorts/...:
//   POST   /api/cohorts                                — define
//   GET    /api/cohorts                                — list
//   GET    /api/cohorts/:cohortId                      — manifest + runs
//   POST   /api/cohorts/:cohortId/runs                 — start run
//   GET    /api/cohorts/:cohortId/runs/:runId/status   — run status
//   POST   /api/cohorts/:cohortId/runs/:runId/sample   — draw stratified sample
//   GET    /api/cohorts/:cohortId/runs/:runId/sample   — sample queue
//   GET    /api/cohorts/:cohortId/sample/validations/:patientId/state
//   POST   /api/cohorts/:cohortId/sample/validations/:patientId/state
//   GET    /api/cohorts/:cohortId/runs/:runId/sample/patients/:patientId/draft
//   GET    /api/cohorts/:cohortId/runs/:runId/report   — deployment-κ
//   POST   /api/cohorts/:cohortId/runs/:runId/report   — persist + recompute

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import {
  defineCohort, listCohorts, getCohortManifest, listCohortRuns,
  startCohortRun, drawStratifiedSample, readValidationState,
  writeValidationState, buildSampleQueue, readCohortAgentDraft,
  blindDraft, type SampleStrategy,
} from "../../chart-review-platform/app/server/domain/cohort/index.js";
import {
  getRunManifest, getRunStatus,
} from "../../chart-review-platform/app/server/infra/batch-run/index.js";
import {
  computeDeploymentKappa, computeAndPersistDeploymentKappa,
  loadPersistedReport,
} from "../../chart-review-platform/app/server/deployment-kappa.js";
import type { AgentDraft } from "../../chart-review-platform/app/server/disagreements.js";

function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT
    ?? path.resolve(process.cwd(), "..", "chart-review-platform");
}
function runsRootDir(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(platformRoot(), "var", "runs");
}
function cohortsRootDir(): string {
  return process.env.CHART_REVIEW_COHORTS_ROOT ?? path.join(platformRoot(), "var", "cohorts");
}

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function gateMethodologist(req: Parameters<RouteEntry["handler"]>[1], action: string): string {
  const reviewerId = readReviewerFromRequest(req);
  if (!isMethodologist(reviewerId)) {
    throw httpErr(403, `${action} requires methodologist privilege`);
  }
  return reviewerId!;
}

export const cohortRoutes: RouteEntry[] = [
  // ── G.1: cohort define + run start ───────────────────────────────────
  {
    method: "POST", pattern: "/api/cohorts",
    handler: async (body, req) => {
      const reviewerId = gateMethodologist(req, "defining a cohort");
      const { cohort_id, task_id, patient_ids, inclusion_criteria_text, notes } = (body ?? {}) as {
        cohort_id?: string; task_id?: string; patient_ids?: string[];
        inclusion_criteria_text?: string; notes?: string;
      };
      if (!cohort_id || !task_id || !patient_ids) {
        throw httpErr(400, "cohort_id, task_id, and patient_ids are required");
      }
      try {
        return defineCohort({
          cohort_id, task_id, patient_ids,
          created_by: reviewerId,
          inclusion_criteria_text, notes,
        });
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
    },
  },

  {
    method: "GET", pattern: "/api/cohorts",
    handler: async () => ({ cohorts: listCohorts() }),
  },

  {
    method: "GET", pattern: "/api/cohorts/:cohortId",
    handler: async (_b, _r, p) => {
      const manifest = getCohortManifest(p.cohortId);
      if (!manifest) throw httpErr(404, "cohort not found");
      const runs = listCohortRuns(p.cohortId);
      return { manifest, runs };
    },
  },

  {
    method: "POST", pattern: "/api/cohorts/:cohortId/runs",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "starting a cohort run");
      const {
        label, max_concurrency, max_turns_per_patient, cost_cap_usd, patient_ids,
      } = (body ?? {}) as {
        label?: string; max_concurrency?: number; max_turns_per_patient?: number;
        cost_cap_usd?: number; patient_ids?: string[];
      };
      try {
        return startCohortRun(p.cohortId, {
          started_by: reviewerId,
          label, max_concurrency, max_turns_per_patient, cost_cap_usd, patient_ids,
        });
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
    },
  },

  {
    method: "GET", pattern: "/api/cohorts/:cohortId/runs/:runId/status",
    handler: async (_b, _r, p) => {
      const s = getRunStatus(p.runId);
      if (!s) throw httpErr(404, "run not found");
      const m = getRunManifest(p.runId);
      if (!m || (m as any).cohort_id !== p.cohortId) {
        throw httpErr(404, "run not found in this cohort");
      }
      return s;
    },
  },

  // ── G.2: stratified sample selection ─────────────────────────────────
  {
    method: "POST", pattern: "/api/cohorts/:cohortId/runs/:runId/sample",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "drawing a sample");
      const manifest = getCohortManifest(p.cohortId);
      if (!manifest) throw httpErr(404, "cohort not found");

      const runManifest = getRunManifest(p.runId);
      if (!runManifest || (runManifest as any).cohort_id !== p.cohortId) {
        throw httpErr(404, "run not found in this cohort");
      }

      const strategy = body as SampleStrategy;
      if (!strategy.n_total || !strategy.stratify_by || !strategy.balance || strategy.seed === undefined) {
        throw httpErr(400, "n_total, stratify_by, balance, and seed are required");
      }

      const runDirPath = path.join(runsRootDir(), p.runId, "per_patient");
      const draftsByPatient: Record<string, AgentDraft> = {};
      if (fs.existsSync(runDirPath)) {
        for (const pid of fs.readdirSync(runDirPath)) {
          const draftFile = path.join(runDirPath, pid, "agent_draft.json");
          if (!fs.existsSync(draftFile)) continue;
          try {
            const raw = JSON.parse(fs.readFileSync(draftFile, "utf8"));
            draftsByPatient[pid] = {
              agent_id: "agent_1",
              patient_id: pid,
              field_assessments: Array.isArray(raw.field_assessments) ? raw.field_assessments : [],
            };
          } catch { /* skip malformed */ }
        }
      }

      try {
        const result = drawStratifiedSample(draftsByPatient, strategy);
        const selectionDir = path.join(cohortsRootDir(), p.cohortId, "sample", "selections");
        fs.mkdirSync(selectionDir, { recursive: true });
        const selectionPath = path.join(selectionDir, `${p.runId}.json`);
        const record = {
          strategy,
          selected: result.selected,
          rationale: result.rationale,
          drawn_at: new Date().toISOString(),
          drawn_by: reviewerId,
        };
        fs.writeFileSync(selectionPath, JSON.stringify(record, null, 2));
        return record;
      } catch (e) {
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  // ── G.3: sample queue + per-patient validation ───────────────────────
  {
    method: "GET", pattern: "/api/cohorts/:cohortId/runs/:runId/sample",
    handler: async (_b, req, p) => {
      gateMethodologist(req, "requires methodologist privilege");
      const manifest = getCohortManifest(p.cohortId);
      if (!manifest) throw httpErr(404, "cohort not found");
      const runManifest = getRunManifest(p.runId);
      if (!runManifest || (runManifest as any).cohort_id !== p.cohortId) {
        throw httpErr(404, "run not found in this cohort");
      }
      const queue = buildSampleQueue(p.cohortId, p.runId, manifest.task_id, runsRootDir());
      if (!queue) throw httpErr(404, "no sample selection found for this run");
      return queue;
    },
  },

  {
    method: "GET", pattern: "/api/cohorts/:cohortId/sample/validations/:patientId/state",
    handler: async (_b, req, p) => {
      gateMethodologist(req, "requires methodologist privilege");
      const manifest = getCohortManifest(p.cohortId);
      if (!manifest) throw httpErr(404, "cohort not found");
      const state = readValidationState(p.cohortId, p.patientId, manifest.task_id);
      if (!state) throw httpErr(404, "no validation state found");
      return state;
    },
  },

  {
    method: "POST", pattern: "/api/cohorts/:cohortId/sample/validations/:patientId/state",
    handler: async (body, req, p) => {
      gateMethodologist(req, "requires methodologist privilege");
      const manifest = getCohortManifest(p.cohortId);
      if (!manifest) throw httpErr(404, "cohort not found");
      if (!body || typeof body !== "object") {
        throw httpErr(400, "request body must be a ReviewState object");
      }
      try {
        writeValidationState(p.cohortId, p.patientId, manifest.task_id, body as Parameters<typeof writeValidationState>[3]);
        return { ok: true };
      } catch (e) {
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  // Blinding: when blind=true and reviewer hasn't fully validated, strip agent answers.
  {
    method: "GET", pattern: "/api/cohorts/:cohortId/runs/:runId/sample/patients/:patientId/draft",
    handler: async (_b, req, p) => {
      gateMethodologist(req, "requires methodologist privilege");
      const manifest = getCohortManifest(p.cohortId);
      if (!manifest) throw httpErr(404, "cohort not found");
      const runManifest = getRunManifest(p.runId);
      if (!runManifest || (runManifest as any).cohort_id !== p.cohortId) {
        throw httpErr(404, "run not found in this cohort");
      }
      const draft = readCohortAgentDraft(runsRootDir(), p.runId, p.patientId);
      if (!draft) throw httpErr(404, "no agent draft found for this patient");

      const blind = (manifest as any).blind !== false;
      if (blind) {
        const reviewState = readValidationState(p.cohortId, p.patientId, manifest.task_id);
        const agentFieldCount = draft.field_assessments.length;
        const reviewerAnswerCount = (reviewState?.field_assessments ?? []).filter(
          (f) => f.source === "reviewer" && f.answer !== undefined && f.answer !== null,
        ).length;
        const fullyValidated = agentFieldCount > 0 && reviewerAnswerCount >= agentFieldCount;
        if (!fullyValidated) return blindDraft(draft);
      }
      return draft;
    },
  },

  // ── G.4: deployment-kappa report ─────────────────────────────────────
  {
    method: "GET", pattern: "/api/cohorts/:cohortId/runs/:runId/report",
    handler: async (_b, req, p) => {
      gateMethodologist(req, "requires methodologist privilege");
      const manifest = getCohortManifest(p.cohortId);
      if (!manifest) throw httpErr(404, "cohort not found");
      const runManifest = getRunManifest(p.runId);
      if (!runManifest || (runManifest as any).cohort_id !== p.cohortId) {
        throw httpErr(404, "run not found in this cohort");
      }
      try {
        const persisted = loadPersistedReport(p.cohortId, p.runId);
        if (persisted) return persisted;
        return computeDeploymentKappa(p.cohortId, p.runId);
      } catch (e) {
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  {
    method: "POST", pattern: "/api/cohorts/:cohortId/runs/:runId/report",
    handler: async (_b, req, p) => {
      gateMethodologist(req, "requires methodologist privilege");
      const manifest = getCohortManifest(p.cohortId);
      if (!manifest) throw httpErr(404, "cohort not found");
      const runManifest = getRunManifest(p.runId);
      if (!runManifest || (runManifest as any).cohort_id !== p.cohortId) {
        throw httpErr(404, "run not found in this cohort");
      }
      try {
        return computeAndPersistDeploymentKappa(p.cohortId, p.runId);
      } catch (e) {
        throw httpErr(500, (e as Error).message);
      }
    },
  },
];
