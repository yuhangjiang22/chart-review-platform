/**
 * adapters/http/run-routes — HTTP adapter for the batch-run primitive (#9).
 *
 * Drives the chart-review skill across N patients. Writes side-channel
 * drafts under runs/<run_id>/ — never touches reviews/<pid>/<task>/.
 *
 * The POST endpoint wires up a WS broadcast callback so the UI sees per-run
 * status transitions in real time. The factory takes the broadcast helper
 * as an argument (matching the reviewerRouter precedent) so this module
 * stays free of WebSocketServer references.
 *
 * Routes registered:
 *   POST   /api/runs                                              — start
 *   GET    /api/runs                                              — list
 *   GET    /api/runs/:runId                                       — manifest
 *   GET    /api/runs/:runId/manifest                              — alias
 *   GET    /api/runs/:runId/per_patient/:patientId/drafts         — agent drafts
 *   GET    /api/runs/:runId/status                                — status
 *   GET    /api/runs/:runId/patients/:patientId/draft             — single draft
 *   GET    /api/runs/:runId/patients/:patientId/audit             — audit lines
 *   DELETE /api/runs/:runId                                       — delete
 *
 * Note: POST /api/runs/:runId/patients/:patientId/import lives in server.ts —
 * it's a review-import action that crosses into reviews/ and is a different
 * concept from the run lifecycle managed here.
 */

import { Router } from "express";
import fs from "fs";
import path from "path";
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
} from "../../infra/batch-run/index.js";
import { reviewerIdOf, isMethodologist } from "../../auth.js";
import { isProviderName } from "../../agent-provider.js";

export function runRouter(broadcastRunUpdate: (status: RunStatus) => void): Router {
  const router = Router();

  router.post("/api/runs", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "starting a run requires methodologist privilege" });
    }
    const {
      task_id,
      patient_ids,
      label,
      max_concurrency,
      max_turns_per_patient,
      cost_cap_usd,
      provider,
    } = req.body ?? {};
    if (!task_id || !Array.isArray(patient_ids) || patient_ids.length === 0) {
      return res.status(400).json({ error: "task_id and non-empty patient_ids are required" });
    }
    if (provider !== undefined && !isProviderName(provider)) {
      return res.status(400).json({ error: `unknown provider: ${provider}` });
    }
    try {
      const result = startBatchRun({
        task_id,
        patient_ids,
        started_by: reviewerId,
        label,
        max_concurrency,
        max_turns_per_patient,
        cost_cap_usd,
        provider,
        onStatus: broadcastRunUpdate,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/runs", (req, res) => {
    const taskId = typeof req.query.task_id === "string" ? req.query.task_id : undefined;
    res.json(listRuns(taskId ? { task_id: taskId } : undefined));
  });

  router.get("/api/runs/:runId", (req, res) => {
    const m = getRunManifest(req.params.runId);
    if (!m) return res.status(404).json({ error: "run not found" });
    res.json(m);
  });

  // Alias — spec pseudocode (Task 6.8) references /manifest explicitly.
  router.get("/api/runs/:runId/manifest", (req, res) => {
    const m = getRunManifest(req.params.runId);
    if (!m) {
      res.status(404).json({ error: `run ${req.params.runId} not found` });
      return;
    }
    res.json(m);
  });

  // Per-agent drafts for a patient — used by DualAgentLayout (Task 6.8).
  router.get("/api/runs/:runId/per_patient/:patientId/drafts", (req, res) => {
    const { runId, patientId } = req.params;
    const dir = path.join(perPatientDir(runId, patientId), "agents");
    if (!fs.existsSync(dir)) {
      res.json({ drafts: [] });
      return;
    }
    const provider = getRunManifest(runId)?.provider;
    const drafts: Array<{ agent_id: string; field_assessments: unknown[]; provider?: string }> = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const agentId = f.replace(/\.json$/, "");
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        drafts.push({
          agent_id: agentId,
          field_assessments: Array.isArray(raw.field_assessments) ? raw.field_assessments : [],
          ...(provider ? { provider } : {}),
        });
      } catch { /* skip malformed */ }
    }
    res.json({ drafts });
  });

  router.get("/api/runs/:runId/status", (req, res) => {
    const s = getRunStatus(req.params.runId);
    if (!s) return res.status(404).json({ error: "run not found" });
    res.json(s);
  });

  router.get("/api/runs/:runId/patients/:patientId/draft", (req, res) => {
    const d = readRunDraft(req.params.runId, req.params.patientId);
    if (d === null) return res.status(404).json({ error: "draft not found" });
    res.json(d);
  });

  router.get("/api/runs/:runId/patients/:patientId/audit", (req, res) => {
    const lines = readRunAuditLines(req.params.runId, req.params.patientId);
    if (lines.length === 0) return res.status(404).json({ error: "audit not found" });
    res.type("application/x-ndjson").send(lines.join("\n") + "\n");
  });

  router.delete("/api/runs/:runId", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "deleting a run requires methodologist privilege" });
    }
    try {
      const ok = deleteRun(req.params.runId);
      if (!ok) return res.status(404).json({ error: "run not found" });
      res.json({ ok: true });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  return router;
}
