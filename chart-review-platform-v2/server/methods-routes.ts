// M6.4 — Methods drafter, migration, and QA-stats endpoints.
//
// Endpoints:
//   POST   /api/methods/:taskId/draft           — generate / refine a draft
//   GET    /api/methods/:taskId/runs            — list persisted drafts
//   GET    /api/methods/:taskId/runs/:runId     — read one persisted draft
//   POST   /api/migration/:taskId/simulate      — preview impact across SHAs
//   POST   /api/migration/:taskId/run           — execute migration
//   GET    /api/qa/:taskId                      — aggregate field-assessment stats

import path from "node:path";
import type { RouteEntry } from "./router.js";
import { readReviewerFromRequest } from "./auth.js";
import {
  draftMethodsSection, listMethodsDrafts, readMethodsDraft,
} from "./lib/methods-drafter.js";
import { simulateImpact } from "./lib/impact-simulator.js";
import { runMigration } from "./lib/migration.js";
import { computeQAStats } from "./lib/qa-panel.js";

function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT
    ?? path.resolve(process.cwd(), "..", "chart-review-platform");
}
function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(platformRoot(), "var", "reviews");
}

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const VALID_METHODS_SECTIONS = ["methods", "results", "limitations", "supplement"] as const;
type MethodsSection = (typeof VALID_METHODS_SECTIONS)[number];

export const methodsRoutes: RouteEntry[] = [
  // ── /api/methods/* ──────────────────────────────────────────────────
  {
    method: "POST", pattern: "/api/methods/:taskId/draft",
    handler: async (body, _req, p) => {
      const { section, prior_draft, feedback, prior_run_id } = (body ?? {}) as {
        section?: string; prior_draft?: string;
        feedback?: string; prior_run_id?: string;
      };
      if (section && !VALID_METHODS_SECTIONS.includes(section as MethodsSection)) {
        throw httpErr(400, `section must be one of ${VALID_METHODS_SECTIONS.join(", ")}`);
      }
      try {
        return await draftMethodsSection({
          taskId: p.taskId,
          reviewsRoot: reviewsRoot(),
          section: section as MethodsSection | undefined,
          prior_draft: typeof prior_draft === "string" ? prior_draft : undefined,
          feedback: typeof feedback === "string" ? feedback : undefined,
          prior_run_id: typeof prior_run_id === "string" ? prior_run_id : undefined,
        });
      } catch (e) {
        throw httpErr(500, String(e));
      }
    },
  },
  {
    method: "GET", pattern: "/api/methods/:taskId/runs",
    handler: async (_b, _r, p) => listMethodsDrafts(p.taskId),
  },
  {
    method: "GET", pattern: "/api/methods/:taskId/runs/:runId",
    handler: async (_b, _r, p) => {
      const r = readMethodsDraft(p.taskId, p.runId);
      if (!r) throw httpErr(404, "draft run not found");
      return r;
    },
  },

  // ── /api/migration/* ────────────────────────────────────────────────
  {
    method: "POST", pattern: "/api/migration/:taskId/simulate",
    handler: async (body, _req, p) => {
      const { from_sha, to_sha } = (body ?? {}) as { from_sha?: string; to_sha?: string };
      if (!from_sha || !to_sha) throw httpErr(400, "from_sha and to_sha required");
      const result = simulateImpact({
        taskId: p.taskId, fromSha: from_sha, toSha: to_sha, reviewsRoot: reviewsRoot(),
      });
      return { ok: true, ...result };
    },
  },
  {
    method: "POST", pattern: "/api/migration/:taskId/run",
    handler: async (body, req, p) => {
      const { from_sha, to_sha, patient_ids, dry_run } = (body ?? {}) as {
        from_sha?: string; to_sha?: string;
        patient_ids?: string[]; dry_run?: boolean;
      };
      if (!from_sha || !to_sha) throw httpErr(400, "from_sha and to_sha required");

      let pids = patient_ids;
      if (!pids) {
        const sim = simulateImpact({
          taskId: p.taskId, fromSha: from_sha, toSha: to_sha, reviewsRoot: reviewsRoot(),
        });
        pids = sim.affected.map((a) => a.patient_id);
      }
      if (dry_run) return { ok: true, dry_run: true, would_migrate: pids };

      const triggered_by = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const result = await runMigration({
        taskId: p.taskId, fromSha: from_sha, toSha: to_sha,
        patientIds: pids, reviewsRoot: reviewsRoot(), triggeredBy: triggered_by,
      });
      return { ok: true, ...result };
    },
  },

  // ── /api/qa/:taskId ─────────────────────────────────────────────────
  {
    method: "GET", pattern: "/api/qa/:taskId",
    handler: async (_b, _r, p) => {
      try { return await computeQAStats(p.taskId, reviewsRoot()); }
      catch (e) { throw httpErr(400, (e as Error).message); }
    },
  },
];
