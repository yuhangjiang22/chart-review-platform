/**
 * adapters/http/guideline-routes — HTTP adapter for guideline-level meta
 * routes: calibration-blinding toggle (#29), the guideline-improvement
 * driver, the guideline-calibration driver, the bundle-SHA endpoint (#19),
 * and the maturity state machine (#13).
 *
 * These all hang off the same /api/guidelines/:taskId or
 * /api/guideline-{improvement,calibration}/:taskId namespaces and share
 * methodologist-privilege gating for write paths.
 *
 * Routes registered:
 *   POST   /api/guidelines/:taskId/blinding
 *   POST   /api/guideline-improvement/:taskId
 *   GET    /api/guideline-improvement/:taskId/cell-count
 *   GET    /api/guideline-improvement/:taskId/proposals
 *   GET    /api/guideline-improvement/:taskId/proposals/:proposalId
 *   GET    /api/guideline-improvement/:taskId/analysis-summary
 *   POST   /api/guideline-calibration/:taskId
 *   GET    /api/guideline-calibration/:taskId/runs
 *   GET    /api/guideline-calibration/:taskId/runs/:runId
 *   GET    /api/guidelines/:taskId/sha
 *   GET    /api/guidelines/:taskId/maturity
 *   POST   /api/guidelines/:taskId/maturity
 *   POST   /api/guidelines/:taskId/fork-to-draft
 */

import { Router } from "express";
import fs from "fs";
import path from "path";
import {
  improveGuideline,
  listImprovementProposals,
  readImprovementProposal,
} from "../../domain/proposal/index.js";
import { PLATFORM_ROOT } from "../../patients.js";
import { calibrateGuideline } from "../../guideline-calibration.js";
import { guidelineDir } from "../../domain/rubric/index.js";
import { computeTaskSha } from "../../lock.js";
import {
  getMaturity,
  transitionMaturity,
  setCalibrationBlinded,
  MATURITY_STATES,
  type MaturityState,
} from "../../maturity.js";
import { forkLockedToDraft } from "../../authoring.js";
import { reviewerIdOf, isMethodologist } from "../../auth.js";

export function guidelineRouter(): Router {
  const router = Router();

  // Toggle calibration blinding for a task (#29). Methodologist-only.
  router.post("/api/guidelines/:taskId/blinding", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "toggling blinding requires methodologist privilege" });
    }
    const blinded = req.body?.blinded === true;
    res.json(setCalibrationBlinded(req.params.taskId, blinded));
  });

  // ── guideline-improvement ────────────────────────────────────────────────────
  // Drives the guideline-improvement skill. POST a guideline + patient cohort
  // (and optionally a focus criterion); the skill clusters reviewer overrides
  // into concrete proposed edits and writes one YAML per cluster under
  // proposals/<guideline_id>/.
  router.post("/api/guideline-improvement/:taskId", async (req, res) => {
    const { taskId } = req.params as { taskId: string };
    const { patient_ids, focus_criterion } = (req.body ?? {}) as {
      patient_ids?: string[];
      focus_criterion?: string;
    };
    if (!Array.isArray(patient_ids) || patient_ids.length === 0) {
      return res
        .status(400)
        .json({ error: "patient_ids[] required (non-empty)" });
    }
    try {
      const result = await improveGuideline({
        guideline_id: taskId,
        patient_ids,
        focus_criterion,
      });
      res.status(result.ok ? 200 : 500).json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── cell-count (A3) ─────────────────────────────────────────────────────────
  // Canonical validated-cell count read directly from review_state.json on disk.
  // A cell is validated when a field_assessment has updated_by === "reviewer"
  // AND the top-level review_status is "reviewer_validated" or "locked" on the
  // same patient. See docs/CONTEXT.md "Validated cell" definition.
  router.get("/api/guideline-improvement/:taskId/cell-count", (req, res) => {
    const { taskId } = req.params as { taskId: string };
    const reviewsRoot =
      process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "reviews");

    let validated = 0;
    let total = 0;

    if (!fs.existsSync(reviewsRoot)) {
      return res.json({ validated, total });
    }

    for (const pid of fs.readdirSync(reviewsRoot)) {
      const rsPath = path.join(reviewsRoot, pid, taskId, "review_state.json");
      if (!fs.existsSync(rsPath)) continue;
      try {
        const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
          review_status?: string;
          field_assessments?: Array<{ updated_by?: string }>;
        };
        const isComplete =
          rs.review_status === "reviewer_validated" ||
          rs.review_status === "locked";
        const fieldAssessments = rs.field_assessments ?? [];
        const reviewerCells = fieldAssessments.filter(
          (fa) => fa.updated_by === "reviewer",
        ).length;
        total += fieldAssessments.length;
        if (isComplete) {
          validated += reviewerCells;
        }
      } catch { /* ignore malformed files */ }
    }

    res.json({ validated, total });
  });

  router.get("/api/guideline-improvement/:taskId/proposals", (req, res) => {
    res.json(listImprovementProposals(req.params.taskId));
  });

  router.get(
    "/api/guideline-improvement/:taskId/proposals/:proposalId",
    (req, res) => {
      const yaml = readImprovementProposal(
        req.params.taskId,
        req.params.proposalId,
      );
      if (yaml === null) return res.status(404).json({ error: "proposal not found" });
      res.type("text/yaml").send(yaml);
    },
  );

  // Dismiss a proposal — deletes the YAML file. Used by the Improvement
  // Proposals panel's Dismiss button. Idempotent: returns ok even when
  // the file is already gone.
  router.delete(
    "/api/guideline-improvement/:taskId/proposals/:proposalId",
    (req, res) => {
      const { taskId, proposalId } = req.params;
      if (!/^[a-z][a-z0-9-]+$/.test(taskId)) {
        return res.status(400).json({ ok: false, error: "invalid taskId" });
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(proposalId)) {
        return res.status(400).json({ ok: false, error: "invalid proposalId" });
      }
      const proposalsRootEnv = process.env.CHART_REVIEW_PROPOSALS_ROOT;
      const proposalsBase = proposalsRootEnv
        ?? path.join(
          process.env.CHART_REVIEW_PLATFORM_ROOT ?? path.resolve(process.cwd(), ".."),
          "proposals",
        );
      const filePath = path.join(proposalsBase, taskId, `${proposalId}.yaml`);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.json({ ok: true });
      } catch (e) {
        return res.status(500).json({ ok: false, error: (e as Error).message });
      }
    },
  );

  // ── analysis-summary (cluster 4 — A5) ────────────────────────────────────────
  // Returns proposals/<taskId>/ANALYSIS_SUMMARY.md as text/markdown, or 404
  // if the file is absent (happens when no proposals were generated).
  router.get("/api/guideline-improvement/:taskId/analysis-summary", (req, res) => {
    const { taskId } = req.params as { taskId: string };
    const proposalsRoot =
      process.env.CHART_REVIEW_PROPOSALS_ROOT ?? path.join(PLATFORM_ROOT, "proposals");
    const summaryPath = path.join(proposalsRoot, taskId, "ANALYSIS_SUMMARY.md");
    if (!fs.existsSync(summaryPath)) {
      return res.status(404).json({ error: "ANALYSIS_SUMMARY.md not found" });
    }
    try {
      const content = fs.readFileSync(summaryPath, "utf8");
      res.type("text/markdown").send(content);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── guideline-calibration ────────────────────────────────────────────────────
  // Deterministic v1: walks the guideline's leaf criteria, replays reviewer
  // answers via kappa.ts, computes Cohen's κ per criterion, and writes
  // calibration/<guideline-id>/<run-id>/{raw.json, report.md}. Acts as the
  // pre-lock release gate.
  router.post("/api/guideline-calibration/:taskId", async (req, res) => {
    const { taskId } = req.params as { taskId: string };
    const { run_id, kappa_threshold, min_shared } = (req.body ?? {}) as {
      run_id?: string;
      kappa_threshold?: number;
      min_shared?: number;
    };
    try {
      const result = await calibrateGuideline({
        guideline_id: taskId,
        run_id,
        kappa_threshold,
        min_shared,
      });
      res.status(result.ok ? 200 : 500).json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // List calibration runs for a task (newest first).
  router.get("/api/guideline-calibration/:taskId/runs", (req, res) => {
    const { taskId } = req.params as { taskId: string };
    const dir = path.join(
      process.env.CHART_REVIEW_PLATFORM_ROOT ?? path.resolve(process.cwd(), ".."),
      "calibration",
      taskId,
    );
    if (!fs.existsSync(dir)) return res.json([]);
    const out: Array<{ run_id: string; archived_at: string }> = [];
    for (const name of fs.readdirSync(dir)) {
      const raw = path.join(dir, name, "raw.json");
      if (!fs.existsSync(raw)) continue;
      const stat = fs.statSync(raw);
      out.push({ run_id: name, archived_at: stat.mtime.toISOString() });
    }
    res.json(out.sort((a, b) => b.archived_at.localeCompare(a.archived_at)));
  });

  // Read raw.json + report.md for a specific calibration run.
  router.get("/api/guideline-calibration/:taskId/runs/:runId", (req, res) => {
    const { taskId, runId } = req.params as { taskId: string; runId: string };
    const dir = path.join(
      process.env.CHART_REVIEW_PLATFORM_ROOT ?? path.resolve(process.cwd(), ".."),
      "calibration",
      taskId,
      runId,
    );
    const rawPath = path.join(dir, "raw.json");
    const reportPath = path.join(dir, "report.md");
    if (!fs.existsSync(rawPath)) return res.status(404).json({ error: "calibration run not found" });
    try {
      const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
      const report_md = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "";
      res.json({ raw, report_md });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── guideline sha (#19) ──────────────────────────────────────────────────────
  // Lightweight endpoint: returns the 16-char hex SHA of the compiled bundle so
  // the Authoring→Pilots handoff card can display a sha prefix without loading
  // the full task object.
  router.get("/api/guidelines/:taskId/sha", (req, res) => {
    try {
      const sha = computeTaskSha(guidelineDir(req.params.taskId));
      res.json({ sha });
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  // ── guideline maturity (#13) ─────────────────────────────────────────────────
  // guidelines/<task>/maturity.json — draft → piloted → calibrated → locked.
  // Workflow metadata; not part of computeTaskSha.
  router.get("/api/guidelines/:taskId/maturity", (req, res) => {
    res.json(getMaturity(req.params.taskId));
  });

  router.post("/api/guidelines/:taskId/maturity", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "transitioning maturity requires methodologist privilege" });
    }
    const { state, reason } = req.body ?? {};
    if (!state || !MATURITY_STATES.includes(state)) {
      return res.status(400).json({ error: `state must be one of ${MATURITY_STATES.join(", ")}` });
    }
    try {
      res.json(transitionMaturity(req.params.taskId, state as MaturityState, reviewerId, reason));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── fork-to-draft ────────────────────────────────────────────────────────────
  // Copy a live guideline at .claude/skills/chart-review-<task>/ into a new draft at
  // .claude/skills/chart-review-<new_task_id>/ (status: draft). The "Edit" affordance in the
  // Guideline tab routes through here when the source is locked / piloted / calibrated;
  // edits then proceed against the new draft via the Builder.
  router.post("/api/guidelines/:taskId/fork-to-draft", (req, res) => {
    const result = forkLockedToDraft({
      src_task_id: req.params.taskId,
      new_task_id: req.body?.new_task_id,
      force: req.body?.force === true,
    });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  return router;
}
