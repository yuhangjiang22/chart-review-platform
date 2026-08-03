// app/server/methodologist.ts
//
// Read-only endpoints for methodologist / external reviewer.
// All routes are protected by viewerAuthMiddleware() from auth.ts.
//
// GET  /api/methodologist/:task_id
//      → { task, qa, sample_record_ids }
//
// GET  /api/methodologist/:task_id/records/:patient_id
//      → { review_state, audit_summary }

import { Router } from "express";
import fs from "fs";
import path from "path";
import { viewerAuthMiddleware } from "./auth.js";
import { computeQAStats } from "./qa-panel.js";
import { loadCompiledTask } from "./tasks.js";
import { REVIEWS_ROOT } from "./domain/review/index.js";
import { readAuditEntries } from "./audit-trail.js";
import { generatePdf } from "./methodologist-pdf.js";
import { readJsonOrNull } from "./storage.js";

/** Re-read each call so tests can override CHART_REVIEW_REVIEWS_ROOT. */
function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? REVIEWS_ROOT;
}

export function methodologistRouter(): Router {
  const r = Router();

  // ------------------------------------------------------------------
  // GET /api/methodologist/:task_id
  // Returns task definition, QA stats, and sample record IDs.
  // ------------------------------------------------------------------
  r.get(
    "/api/methodologist/:task_id",
    viewerAuthMiddleware(),
    async (req, res) => {
      const { task_id } = req.params as { task_id: string };
      const task = loadCompiledTask(task_id);
      if (!task)
        return res.status(404).json({ ok: false, error: "task not found" });

      const qa = await computeQAStats(task_id, reviewsRoot());
      const sample_record_ids = collectSampleRecordIds(reviewsRoot(), task_id, 10);

      res.json({ task, qa, sample_record_ids });
    },
  );

  // ------------------------------------------------------------------
  // GET /api/methodologist/:task_id/records/:patient_id
  // Returns review_state + projected audit_summary for one patient.
  // ------------------------------------------------------------------
  r.get(
    "/api/methodologist/:task_id/records/:patient_id",
    viewerAuthMiddleware(),
    async (req, res) => {
      const { task_id, patient_id } = req.params as {
        task_id: string;
        patient_id: string;
      };

      const rsPath = path.join(
        reviewsRoot(),
        patient_id,
        task_id,
        "review_state.json",
      );
      if (!fs.existsSync(rsPath))
        return res.status(404).json({ ok: false, error: "record not found" });

      const review_state = JSON.parse(fs.readFileSync(rsPath, "utf8"));

      // Walk all chat session JSONLs and project each entry to { ts, step_type, reviewer_id }.
      const chatDir = path.join(reviewsRoot(), patient_id, task_id, "chat");
      const audit_summary: Array<{
        ts: string;
        step_type: string;
        reviewer_id?: string;
      }> = [];

      if (fs.existsSync(chatDir)) {
        for (const f of fs.readdirSync(chatDir)) {
          if (!f.endsWith(".jsonl")) continue;
          const sessionId = f.replace(/\.jsonl$/, "");
          const entries = readAuditEntries({
            patientId: patient_id,
            taskId: task_id,
            sessionId,
          });
          for (const e of entries) {
            audit_summary.push({
              ts: e.ts,
              step_type: e.step_type,
              reviewer_id: (e as { reviewer_id?: string }).reviewer_id,
            });
          }
        }
        audit_summary.sort((a, b) => (a.ts < b.ts ? -1 : 1));
      }

      res.json({ review_state, audit_summary });
    },
  );

  // ------------------------------------------------------------------
  // GET /api/methodologist/:task_id/report.pdf
  // Streams PDF report for the task.
  // ------------------------------------------------------------------
  r.get(
    "/api/methodologist/:task_id/report.pdf",
    viewerAuthMiddleware(),
    async (req, res) => {
      const { task_id } = req.params as { task_id: string };
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${task_id}-report.pdf"`,
      );
      const stream = await generatePdf(task_id, reviewsRoot());
      stream.pipe(res);
    },
  );

  return r;
}

// ---------------------------------------------------------------------------
// Helper: collect up to `limit` sample patient IDs for a task.
// Prefers records with review_status === "locked" (sorted by locked_at desc),
// then falls back to "reviewer_validated" (sorted by updated_at desc).
// Skips directories starting with "_" (e.g. _auth).
// ---------------------------------------------------------------------------
function collectSampleRecordIds(
  root: string,
  taskId: string,
  limit: number,
): string[] {
  if (!fs.existsSync(root)) return [];

  const candidates: Array<{
    pid: string;
    locked_at?: string;
    updated_at?: string;
    review_status?: string;
  }> = [];

  for (const pid of fs.readdirSync(root)) {
    if (pid.startsWith("_")) continue;
    const rsPath = path.join(root, pid, taskId, "review_state.json");
    const rs = readJsonOrNull<{
      locked_at?: string;
      updated_at?: string;
      review_status?: string;
    }>(rsPath);
    if (!rs) continue;
    candidates.push({ pid, ...rs });
  }

  const locked = candidates
    .filter((c) => c.review_status === "locked")
    .sort((a, b) =>
      (a.locked_at ?? "") < (b.locked_at ?? "") ? 1 : -1,
    );

  const validated = candidates
    .filter((c) => c.review_status === "reviewer_validated")
    .sort((a, b) =>
      (a.updated_at ?? "") < (b.updated_at ?? "") ? 1 : -1,
    );

  return [...locked, ...validated].slice(0, limit).map((c) => c.pid);
}
