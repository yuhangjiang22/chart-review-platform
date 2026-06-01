// M6.7 — bundle + preflight + guideline routes ported from v1.
//
// Three groupings glued together because they're all task-meta endpoints
// and small individually.
//
// Bundle (#19 / #47 / #48):
//   POST   /api/exports/:taskId                     — build a bundle (methodologist)
//   GET    /api/exports/:taskId                     — list bundles
//   GET    /api/exports/:taskId/:bundleId           — read one manifest
//   GET    /api/exports/:taskId/:bundleId/download  — stream tar.gz (methodologist)
//   GET    /api/budget/:taskId                      — cumulative spend pill
//
// Preflight (cluster 6 — W1):
//   GET    /api/tasks/:taskId/preflight             — AUTHOR phase pre-flight
//
// Guideline meta (blinding, improvement, calibration, sha, maturity, fork):
//   POST   /api/guidelines/:taskId/blinding
//   POST   /api/guideline-improvement/:taskId
//   GET    /api/guideline-improvement/:taskId/cell-count
//   GET    /api/guideline-improvement/:taskId/proposals
//   GET    /api/guideline-improvement/:taskId/proposals/:proposalId
//   DELETE /api/guideline-improvement/:taskId/proposals/:proposalId
//   GET    /api/guideline-improvement/:taskId/analysis-summary
//   POST   /api/guideline-calibration/:taskId
//   GET    /api/guideline-calibration/:taskId/runs
//   GET    /api/guideline-calibration/:taskId/runs/:runId
//   GET    /api/guidelines/:taskId/sha
//   GET    /api/guidelines/:taskId/maturity
//   POST   /api/guidelines/:taskId/maturity
//   POST   /api/guidelines/:taskId/fork-to-draft

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import type { RawBody } from "./core-routes.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";

// Bundle imports
import {
  exportBundle, listExports, exportsRoot, makeTarball,
} from "./lib/domain/bundle/index.js";
import { cohortSpend } from "./lib/infra/batch-run/index.js";

// Preflight import
import { runPreflight } from "./lib/adapters/http/preflight-routes.js";

// Guideline imports
import {
  improveGuideline, improveNerTask, improveAdherenceTask, applyNerProposal, applyAdherenceProposal,
  listImprovementProposals, readImprovementProposal,
} from "./lib/domain/proposal/index.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { calibrateGuideline } from "./lib/guideline-calibration.js";
import { guidelineDir } from "./lib/domain/rubric/index.js";
import { computeTaskSha } from "./lib/lock.js";
import {
  getMaturity, transitionMaturity, setCalibrationBlinded,
  MATURITY_STATES, type MaturityState,
} from "./lib/maturity.js";
import { forkLockedToDraft } from "./lib/authoring.js";

function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT
    ?? path.resolve(process.cwd(), "..", "chart-review-platform");
}
function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(platformRoot(), "var", "reviews");
}
function proposalsRoot(): string {
  return process.env.CHART_REVIEW_PROPOSALS_ROOT ?? path.join(platformRoot(), "var", "proposals");
}
function calibrationRoot(): string {
  return process.env.CHART_REVIEW_CALIBRATION_ROOT
    ?? path.join(platformRoot(), "var", "calibration");
}

function httpErr(status: number, message: string, payload?: unknown): Error & { status: number; payload?: unknown } {
  const err = new Error(message) as Error & { status: number; payload?: unknown };
  err.status = status;
  if (payload) err.payload = payload;
  return err;
}

function gateMethodologist(req: Parameters<RouteEntry["handler"]>[1], action: string): string {
  const reviewerId = readReviewerFromRequest(req);
  if (!isMethodologist(reviewerId)) {
    throw httpErr(403, `${action} requires methodologist privilege`);
  }
  return reviewerId!;
}

export const guidelineRoutes: RouteEntry[] = [
  // ── Bundle ──────────────────────────────────────────────────────────
  {
    method: "POST", pattern: "/api/exports/:taskId",
    handler: async (body, req, p, query) => {
      const reviewerId = gateMethodologist(req, "exporting");
      const tarballParam = query.get("tarball");
      const tarball =
        tarballParam === "1" || tarballParam === "true"
        || (body as { tarball?: boolean })?.tarball === true;
      const result = exportBundle({
        task_id: p.taskId,
        exported_by: reviewerId,
        tarball,
      });
      if (!result.ok) throw httpErr(400, "exportBundle failed", result);
      return result;
    },
  },

  {
    method: "GET", pattern: "/api/exports/:taskId",
    handler: async (_b, _r, p) => listExports(p.taskId),
  },

  {
    method: "GET", pattern: "/api/exports/:taskId/:bundleId",
    handler: async (_b, _r, p) => {
      const manifestPath = path.join(exportsRoot(), p.taskId, p.bundleId, "manifest.json");
      if (!fs.existsSync(manifestPath)) throw httpErr(404, "bundle manifest not found");
      try { return JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
      catch (e) { throw httpErr(500, (e as Error).message); }
    },
  },

  {
    method: "GET", pattern: "/api/exports/:taskId/:bundleId/download",
    handler: async (_b, req, p) => {
      gateMethodologist(req, "downloading");
      const bundleDir = path.join(exportsRoot(), p.taskId, p.bundleId);
      if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
        throw httpErr(404, "bundle not found");
      }
      const archive = `${bundleDir}.tar.gz`;
      if (!fs.existsSync(archive)) {
        try { makeTarball(bundleDir); }
        catch (e) { throw httpErr(500, `tar failed: ${(e as Error).message}`); }
      }
      // Read as Buffer; the response writer in server/index.ts handles
      // Buffer bodies without UTF-8 re-encoding (a string round-trip
      // here would corrupt the gzip and the user sees "unsupported
      // format" when they try to open the tar.gz).
      const raw: RawBody = {
        __raw: true,
        contentType: "application/gzip",
        body: fs.readFileSync(archive),
      };
      return raw;
    },
  },

  {
    method: "GET", pattern: "/api/budget/:taskId",
    handler: async (_b, _r, p) => cohortSpend(p.taskId),
  },

  // ── Preflight ───────────────────────────────────────────────────────
  {
    method: "GET", pattern: "/api/tasks/:taskId/preflight",
    handler: async (_b, _r, p) => {
      try { return runPreflight(p.taskId); }
      catch (e) {
        throw httpErr(500, `Preflight check failed: ${(e as Error).message}`, {
          ok: false,
          diagnostics: [{
            code: "preflight_internal_error", path: "",
            message: `Preflight check failed: ${(e as Error).message}`,
            level: "error",
          }],
        });
      }
    },
  },

  // ── Guideline meta ──────────────────────────────────────────────────
  {
    method: "POST", pattern: "/api/guidelines/:taskId/blinding",
    handler: async (body, req, p) => {
      gateMethodologist(req, "toggling blinding");
      const blinded = (body as { blinded?: boolean })?.blinded === true;
      return setCalibrationBlinded(p.taskId, blinded);
    },
  },

  {
    method: "POST", pattern: "/api/guideline-improvement/:taskId",
    handler: async (body, _r, p) => {
      const { patient_ids, focus_criterion, focus_entity_type, focus_question_id } = (body ?? {}) as {
        patient_ids?: string[];
        focus_criterion?: string;
        focus_entity_type?: string;
        focus_question_id?: string;
      };
      if (!Array.isArray(patient_ids) || patient_ids.length === 0) {
        throw httpErr(400, "patient_ids[] required (non-empty)");
      }
      // task_kind dispatch:
      //   - NER → span-shaped driver, proposals patch entity-type-guidance YAMLs
      //   - adherence → question/rule-shaped driver, proposals patch
      //     references/questions/*.yaml and references/rules/*.yaml
      //   - phenotype → original criterion-shaped driver
      const task = loadCompiledTask(p.taskId);
      try {
        if (task?.task_kind === "ner") {
          const result = await improveNerTask({
            task_id: p.taskId, patient_ids, focus_entity_type,
          });
          if (!result.ok) throw httpErr(500, (result as { error?: string }).error ?? "improveNerTask failed", result);
          return result;
        }
        if (task?.task_kind === "adherence") {
          const result = await improveAdherenceTask({
            task_id: p.taskId, patient_ids, focus_question_id,
          });
          if (!result.ok) throw httpErr(500, (result as { error?: string }).error ?? "improveAdherenceTask failed", result);
          return result;
        }
        const result = await improveGuideline({
          guideline_id: p.taskId, patient_ids, focus_criterion,
        });
        if (!result.ok) throw httpErr(500, (result as { error?: string }).error ?? "improveGuideline failed", result);
        return result;
      } catch (e) {
        if ((e as { status?: number }).status) throw e;
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  {
    method: "GET", pattern: "/api/guideline-improvement/:taskId/cell-count",
    handler: async (_b, _r, p) => {
      const root = reviewsRoot();
      let validated = 0;
      let total = 0;
      if (!fs.existsSync(root)) return { validated, total };
      for (const pid of fs.readdirSync(root)) {
        const rsPath = path.join(root, pid, p.taskId, "review_state.json");
        if (!fs.existsSync(rsPath)) continue;
        try {
          const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
            review_status?: string;
            field_assessments?: Array<{ updated_by?: string }>;
          };
          const isComplete = rs.review_status === "reviewer_validated" || rs.review_status === "locked";
          const fas = rs.field_assessments ?? [];
          const reviewerCells = fas.filter((fa) => fa.updated_by === "reviewer").length;
          total += fas.length;
          if (isComplete) validated += reviewerCells;
        } catch { /* ignore malformed */ }
      }
      return { validated, total };
    },
  },

  {
    method: "GET", pattern: "/api/guideline-improvement/:taskId/proposals",
    handler: async (_b, _r, p) => listImprovementProposals(p.taskId),
  },

  {
    method: "GET", pattern: "/api/guideline-improvement/:taskId/proposals/:proposalId",
    handler: async (_b, _r, p) => {
      const yaml = readImprovementProposal(p.taskId, p.proposalId);
      if (yaml === null) throw httpErr(404, "proposal not found");
      const raw: RawBody = { __raw: true, contentType: "text/yaml; charset=utf-8", body: yaml };
      return raw;
    },
  },

  {
    method: "DELETE", pattern: "/api/guideline-improvement/:taskId/proposals/:proposalId",
    handler: async (_b, _r, p) => {
      if (!/^[a-z][a-z0-9-]+$/.test(p.taskId)) throw httpErr(400, "invalid taskId");
      if (!/^[a-zA-Z0-9_-]+$/.test(p.proposalId)) throw httpErr(400, "invalid proposalId");
      const filePath = path.join(proposalsRoot(), p.taskId, `${p.proposalId}.yaml`);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return { ok: true };
      } catch (e) {
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  // POST /api/guideline-improvement/:taskId/proposals/:proposalId/apply
  // Apply a proposal by task_kind:
  //   - ner       → patch entity_type_guidance YAML
  //   - adherence → patch references/questions/*.yaml or references/rules/*.yaml
  //   - phenotype → not supported here (legacy rule-store has its own path)
  // The proposal is archived under <proposals>/<task>/applied/ on success.
  {
    method: "POST", pattern: "/api/guideline-improvement/:taskId/proposals/:proposalId/apply",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      let result: { ok: boolean; error?: string; applied_to?: string; archived_to?: string };
      if (task?.task_kind === "ner") {
        result = applyNerProposal(p.taskId, p.proposalId);
      } else if (task?.task_kind === "adherence") {
        result = applyAdherenceProposal(p.taskId, p.proposalId);
      } else {
        throw httpErr(400, "apply only supported for NER and adherence tasks");
      }
      if (!result.ok) {
        const err = httpErr(400, result.error ?? "apply failed");
        (err as Error & { payload?: unknown }).payload = result;
        throw err;
      }
      return result;
    },
  },

  {
    method: "GET", pattern: "/api/guideline-improvement/:taskId/analysis-summary",
    handler: async (_b, _r, p) => {
      const summaryPath = path.join(proposalsRoot(), p.taskId, "ANALYSIS_SUMMARY.md");
      if (!fs.existsSync(summaryPath)) throw httpErr(404, "ANALYSIS_SUMMARY.md not found");
      try {
        const content = fs.readFileSync(summaryPath, "utf8");
        const raw: RawBody = { __raw: true, contentType: "text/markdown; charset=utf-8", body: content };
        return raw;
      } catch (e) {
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  {
    method: "POST", pattern: "/api/guideline-calibration/:taskId",
    handler: async (body, _r, p) => {
      const { run_id, kappa_threshold, min_shared } = (body ?? {}) as {
        run_id?: string; kappa_threshold?: number; min_shared?: number;
      };
      try {
        const result = await calibrateGuideline({
          guideline_id: p.taskId, run_id, kappa_threshold, min_shared,
        });
        if (!result.ok) throw httpErr(500, (result as { error?: string }).error ?? "calibrateGuideline failed", result);
        return result;
      } catch (e) {
        if ((e as { status?: number }).status) throw e;
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  {
    method: "GET", pattern: "/api/guideline-calibration/:taskId/runs",
    handler: async (_b, _r, p) => {
      const dir = path.join(calibrationRoot(), p.taskId);
      if (!fs.existsSync(dir)) return [];
      const out: Array<{ run_id: string; archived_at: string }> = [];
      for (const name of fs.readdirSync(dir)) {
        const raw = path.join(dir, name, "raw.json");
        if (!fs.existsSync(raw)) continue;
        out.push({ run_id: name, archived_at: fs.statSync(raw).mtime.toISOString() });
      }
      return out.sort((a, b) => b.archived_at.localeCompare(a.archived_at));
    },
  },

  {
    method: "GET", pattern: "/api/guideline-calibration/:taskId/runs/:runId",
    handler: async (_b, _r, p) => {
      const dir = path.join(calibrationRoot(), p.taskId, p.runId);
      const rawPath = path.join(dir, "raw.json");
      const reportPath = path.join(dir, "report.md");
      if (!fs.existsSync(rawPath)) throw httpErr(404, "calibration run not found");
      try {
        const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
        const report_md = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "";
        return { raw, report_md };
      } catch (e) {
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  {
    method: "GET", pattern: "/api/guidelines/:taskId/sha",
    handler: async (_b, _r, p) => {
      try { return { sha: computeTaskSha(guidelineDir(p.taskId)) }; }
      catch (e) {
        throw httpErr(500, String(e instanceof Error ? e.message : e));
      }
    },
  },

  {
    method: "GET", pattern: "/api/guidelines/:taskId/maturity",
    handler: async (_b, _r, p) => getMaturity(p.taskId),
  },

  {
    method: "POST", pattern: "/api/guidelines/:taskId/maturity",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "transitioning maturity");
      const { state, reason } = (body ?? {}) as { state?: string; reason?: string };
      if (!state || !MATURITY_STATES.includes(state as MaturityState)) {
        throw httpErr(400, `state must be one of ${MATURITY_STATES.join(", ")}`);
      }
      try {
        return transitionMaturity(p.taskId, state as MaturityState, reviewerId, reason);
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
    },
  },

  {
    method: "POST", pattern: "/api/guidelines/:taskId/fork-to-draft",
    handler: async (body, _r, p) => {
      const result = forkLockedToDraft({
        src_task_id: p.taskId,
        new_task_id: (body as { new_task_id?: string })?.new_task_id,
        force: (body as { force?: boolean })?.force === true,
      });
      if (!result.ok) throw httpErr(400, (result as { error?: string }).error ?? "fork failed", result);
      return result;
    },
  },
];
