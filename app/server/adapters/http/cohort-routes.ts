/**
 * adapters/http/cohort-routes — HTTP adapter for the deployment Cohort
 * pipeline (G.1 → G.4): cohort define + run + sample + per-patient
 * validation + deployment-kappa report.
 *
 * Routes registered (all require methodologist except listings):
 *   POST   /api/cohorts                                — define
 *   GET    /api/cohorts                                — list
 *   GET    /api/cohorts/:cohortId                      — manifest + runs
 *   POST   /api/cohorts/:cohortId/runs                 — start run
 *   GET    /api/cohorts/:cohortId/runs/:runId/status   — run status
 *   POST   /api/cohorts/:cohortId/runs/:runId/sample   — draw sample (G.2)
 *   GET    /api/cohorts/:cohortId/runs/:runId/sample   — sample queue (G.3)
 *   GET    /api/cohorts/:cohortId/sample/validations/:patientId/state
 *   POST   /api/cohorts/:cohortId/sample/validations/:patientId/state
 *   GET    /api/cohorts/:cohortId/runs/:runId/sample/patients/:patientId/draft
 *   GET    /api/cohorts/:cohortId/runs/:runId/report   — deployment-κ
 *   POST   /api/cohorts/:cohortId/runs/:runId/report   — persist + recompute
 */

import express, { Router } from "express";
import fs from "fs";
import path from "path";
import {
  defineCohort,
  listCohorts,
  getCohortManifest,
  listCohortRuns,
  startCohortRun,
  drawStratifiedSample,
  type SampleStrategy,
  readValidationState,
  writeValidationState,
  buildSampleQueue,
  readCohortAgentDraft,
  blindDraft,
} from "../../domain/cohort/index.js";
import { getRunManifest, getRunStatus } from "../../infra/batch-run/index.js";
import {
  computeDeploymentKappa,
  computeAndPersistDeploymentKappa,
  loadPersistedReport,
} from "../../deployment-kappa.js";
import type { AgentDraft } from "../../disagreements.js";
import { reviewerIdOf, isMethodologist } from "../../auth.js";

function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT ?? path.resolve(process.cwd(), "..");
}
function runsRootDir(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(platformRoot(), "runs");
}
function cohortsRootDir(): string {
  return process.env.CHART_REVIEW_COHORTS_ROOT ?? path.join(platformRoot(), "cohorts");
}

export function cohortRouter(): Router {
  const router = Router();

  // ── G.1: cohort define + run start ─────────────────────────────────────────
  router.post("/api/cohorts", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "defining a cohort requires methodologist privilege" });
    }
    const { cohort_id, task_id, patient_ids, inclusion_criteria_text, notes } = req.body ?? {};
    if (!cohort_id || !task_id || !patient_ids) {
      return res.status(400).json({ error: "cohort_id, task_id, and patient_ids are required" });
    }
    try {
      const manifest = defineCohort({
        cohort_id,
        task_id,
        patient_ids,
        created_by: reviewerId,
        inclusion_criteria_text,
        notes,
      });
      res.status(201).json(manifest);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/api/cohorts", (_req, res) => {
    res.json({ cohorts: listCohorts() });
  });

  router.get("/api/cohorts/:cohortId", (req, res) => {
    const manifest = getCohortManifest(req.params.cohortId);
    if (!manifest) return res.status(404).json({ error: "cohort not found" });
    const runs = listCohortRuns(req.params.cohortId);
    res.json({ manifest, runs });
  });

  router.post("/api/cohorts/:cohortId/runs", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "starting a cohort run requires methodologist privilege" });
    }
    const { label, max_concurrency, max_turns_per_patient, cost_cap_usd, patient_ids } = req.body ?? {};
    try {
      const result = startCohortRun(req.params.cohortId, {
        started_by: reviewerId,
        label,
        max_concurrency,
        max_turns_per_patient,
        cost_cap_usd,
        patient_ids,
      });
      res.status(201).json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/api/cohorts/:cohortId/runs/:runId/status", (req, res) => {
    const s = getRunStatus(req.params.runId);
    if (!s) return res.status(404).json({ error: "run not found" });
    const m = getRunManifest(req.params.runId);
    if (!m || (m as any).cohort_id !== req.params.cohortId) {
      return res.status(404).json({ error: "run not found in this cohort" });
    }
    res.json(s);
  });

  // ── G.2: stratified sample selection ───────────────────────────────────────
  router.post("/api/cohorts/:cohortId/runs/:runId/sample", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "drawing a sample requires methodologist privilege" });
    }
    const { cohortId, runId } = req.params;

    const manifest = getCohortManifest(cohortId);
    if (!manifest) return res.status(404).json({ error: "cohort not found" });

    const runManifest = getRunManifest(runId);
    if (!runManifest || (runManifest as any).cohort_id !== cohortId) {
      return res.status(404).json({ error: "run not found in this cohort" });
    }

    const strategy = req.body as SampleStrategy;
    if (!strategy.n_total || !strategy.stratify_by || !strategy.balance || strategy.seed === undefined) {
      return res.status(400).json({ error: "n_total, stratify_by, balance, and seed are required" });
    }

    const runDirPath = path.join(runsRootDir(), runId, "per_patient");
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
        } catch {
          // skip malformed
        }
      }
    }

    try {
      const result = drawStratifiedSample(draftsByPatient, strategy);
      const selectionDir = path.join(cohortsRootDir(), cohortId, "sample", "selections");
      fs.mkdirSync(selectionDir, { recursive: true });
      const selectionPath = path.join(selectionDir, `${runId}.json`);
      const record = {
        strategy,
        selected: result.selected,
        rationale: result.rationale,
        drawn_at: new Date().toISOString(),
        drawn_by: reviewerId,
      };
      fs.writeFileSync(selectionPath, JSON.stringify(record, null, 2));
      res.json(record);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── G.3: sample queue + per-patient validation ─────────────────────────────
  router.get("/api/cohorts/:cohortId/runs/:runId/sample", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "requires methodologist privilege" });
    }
    const { cohortId, runId } = req.params;

    const manifest = getCohortManifest(cohortId);
    if (!manifest) return res.status(404).json({ error: "cohort not found" });

    const runManifest = getRunManifest(runId);
    if (!runManifest || (runManifest as any).cohort_id !== cohortId) {
      return res.status(404).json({ error: "run not found in this cohort" });
    }

    const queue = buildSampleQueue(cohortId, runId, manifest.task_id, runsRootDir());
    if (!queue) return res.status(404).json({ error: "no sample selection found for this run" });

    res.json(queue);
  });

  router.get("/api/cohorts/:cohortId/sample/validations/:patientId/state", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "requires methodologist privilege" });
    }
    const { cohortId, patientId } = req.params;

    const manifest = getCohortManifest(cohortId);
    if (!manifest) return res.status(404).json({ error: "cohort not found" });

    const state = readValidationState(cohortId, patientId, manifest.task_id);
    if (!state) return res.status(404).json({ error: "no validation state found" });
    res.json(state);
  });

  // Fallback REST write for validation state. The canonical path is via the
  // MCP set_field_assessment tool (which writes via withReviewsRoot), but
  // this endpoint allows direct writes for tooling + tests.
  router.post(
    "/api/cohorts/:cohortId/sample/validations/:patientId/state",
    express.json(),
    (req, res) => {
      const reviewerId = reviewerIdOf(req);
      if (!isMethodologist(reviewerId)) {
        return res.status(403).json({ error: "requires methodologist privilege" });
      }
      const { cohortId, patientId } = req.params;

      const manifest = getCohortManifest(cohortId);
      if (!manifest) return res.status(404).json({ error: "cohort not found" });

      const newState = req.body;
      if (!newState || typeof newState !== "object") {
        return res.status(400).json({ error: "request body must be a ReviewState object" });
      }

      try {
        writeValidationState(cohortId, patientId, manifest.task_id, newState);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );

  // Blinding: when the cohort manifest has blind=true and the reviewer hasn't
  // fully validated the patient yet, agent answers are stripped.
  router.get(
    "/api/cohorts/:cohortId/runs/:runId/sample/patients/:patientId/draft",
    (req, res) => {
      const reviewerId = reviewerIdOf(req);
      if (!isMethodologist(reviewerId)) {
        return res.status(403).json({ error: "requires methodologist privilege" });
      }
      const { cohortId, runId, patientId } = req.params;

      const manifest = getCohortManifest(cohortId);
      if (!manifest) return res.status(404).json({ error: "cohort not found" });

      const runManifest = getRunManifest(runId);
      if (!runManifest || (runManifest as any).cohort_id !== cohortId) {
        return res.status(404).json({ error: "run not found in this cohort" });
      }

      const draft = readCohortAgentDraft(runsRootDir(), runId, patientId);
      if (!draft) return res.status(404).json({ error: "no agent draft found for this patient" });

      // Default blind=true for cohort manifests that don't specify.
      const blind = (manifest as any).blind !== false;
      if (blind) {
        const reviewState = readValidationState(cohortId, patientId, manifest.task_id);
        const agentFieldCount = draft.field_assessments.length;
        const reviewerAnswerCount = (reviewState?.field_assessments ?? []).filter(
          (f) => f.source === "reviewer" && f.answer !== undefined && f.answer !== null,
        ).length;
        const fullyValidated = agentFieldCount > 0 && reviewerAnswerCount >= agentFieldCount;
        if (!fullyValidated) {
          return res.json(blindDraft(draft));
        }
      }

      res.json(draft);
    },
  );

  // ── G.4: deployment-kappa report ───────────────────────────────────────────
  router.get("/api/cohorts/:cohortId/runs/:runId/report", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "requires methodologist privilege" });
    }
    const { cohortId, runId } = req.params;

    const manifest = getCohortManifest(cohortId);
    if (!manifest) return res.status(404).json({ error: "cohort not found" });

    const runManifest = getRunManifest(runId);
    if (!runManifest || (runManifest as any).cohort_id !== cohortId) {
      return res.status(404).json({ error: "run not found in this cohort" });
    }

    try {
      const persisted = loadPersistedReport(cohortId, runId);
      if (persisted) return res.json(persisted);
      const result = computeDeploymentKappa(cohortId, runId);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/cohorts/:cohortId/runs/:runId/report", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "requires methodologist privilege" });
    }
    const { cohortId, runId } = req.params;

    const manifest = getCohortManifest(cohortId);
    if (!manifest) return res.status(404).json({ error: "cohort not found" });

    const runManifest = getRunManifest(runId);
    if (!runManifest || (runManifest as any).cohort_id !== cohortId) {
      return res.status(404).json({ error: "run not found in this cohort" });
    }

    try {
      const result = computeAndPersistDeploymentKappa(cohortId, runId);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
