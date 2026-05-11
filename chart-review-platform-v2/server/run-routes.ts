// M6.7 — batch-run primitive routes ported from v1's run-routes.ts.
//
// Endpoints:
//   POST   /api/runs                                              — start (methodologist)
//   GET    /api/runs                                              — list (?task_id)
//   GET    /api/runs/:runId                                       — manifest
//   GET    /api/runs/:runId/manifest                              — alias
//   GET    /api/runs/:runId/per_patient/:patientId/drafts         — per-agent drafts
//   GET    /api/runs/:runId/status                                — status
//   GET    /api/runs/:runId/patients/:patientId/draft             — single draft
//   GET    /api/runs/:runId/patients/:patientId/audit             — audit ndjson
//   DELETE /api/runs/:runId                                       — delete (methodologist)
//
// startBatchRun takes an onStatus broadcaster callback. v2 doesn't own
// the WS broadcaster yet (proxied to v1 by server/index.ts), so we
// pass a no-op stub — clients fall back to polling
// /api/runs/:runId/status. When /ws/* is ported (M6.7c) we wire the
// real broadcaster.

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import type { RawBody } from "./core-routes.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import {
  startBatchRun, getRunManifest, getRunStatus, listRuns,
  readDraft as readRunDraft,
  deleteRun, perPatientDir, type RunStatus,
} from "./lib/infra/batch-run/index.js";
import { isProviderName } from "./lib/agent-provider.js";
import { maybeAutoAdvancePilotOnRunStatus } from "./lib/domain/iter/index.js";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT
    ?? path.resolve(process.cwd(), "..", "chart-review-platform");
}
function runsRoot(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(platformRoot(), "var", "runs");
}

function gateMethodologist(req: Parameters<RouteEntry["handler"]>[1], action: string): string {
  const reviewerId = readReviewerFromRequest(req);
  if (!isMethodologist(reviewerId)) {
    throw httpErr(403, `${action} requires methodologist privilege`);
  }
  return reviewerId!;
}

/** Combined v1-style broadcastRunUpdate: auto-advance pilot iters that
 *  terminated, AND push agent_run_update over WS. The WS broadcast goes
 *  through ws.ts's registry (set up at server boot). */
import { broadcastRunUpdate as wsBroadcastRunUpdate } from "./ws.js";
function onRunStatus(status: RunStatus): void {
  // wsBroadcastRunUpdate already calls maybeAutoAdvancePilotOnRunStatus,
  // so no separate call needed. Kept the named import above so the
  // unused-import lint stays clean.
  wsBroadcastRunUpdate(status);
  void maybeAutoAdvancePilotOnRunStatus; // marker — already called via ws
}

export const runRoutes: RouteEntry[] = [
  {
    method: "POST", pattern: "/api/runs",
    handler: async (body, req) => {
      const reviewerId = gateMethodologist(req, "starting a run");
      const {
        task_id, patient_ids, label, max_concurrency,
        max_turns_per_patient, cost_cap_usd, provider,
      } = (body ?? {}) as {
        task_id?: string; patient_ids?: string[];
        label?: string; max_concurrency?: number;
        max_turns_per_patient?: number; cost_cap_usd?: number;
        provider?: string;
      };
      if (!task_id || !Array.isArray(patient_ids) || patient_ids.length === 0) {
        throw httpErr(400, "task_id and non-empty patient_ids are required");
      }
      if (provider !== undefined && !isProviderName(provider)) {
        throw httpErr(400, `unknown provider: ${provider}`);
      }
      try {
        return startBatchRun({
          task_id, patient_ids,
          started_by: reviewerId, label,
          max_concurrency, max_turns_per_patient, cost_cap_usd,
          provider: provider as Parameters<typeof startBatchRun>[0]["provider"],
          onStatus: onRunStatus,
        });
      } catch (e) {
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  {
    method: "GET", pattern: "/api/runs",
    handler: async (_b, _r, _p, query) => {
      const task_id = query.get("task_id") ?? undefined;
      return listRuns(task_id ? { task_id } : undefined);
    },
  },

  {
    method: "GET", pattern: "/api/runs/:runId",
    handler: async (_b, _r, p) => {
      const m = getRunManifest(p.runId);
      if (!m) throw httpErr(404, "run not found");
      return m;
    },
  },

  // Alias the manifest endpoint per Task 6.8 of the spec.
  {
    method: "GET", pattern: "/api/runs/:runId/manifest",
    handler: async (_b, _r, p) => {
      const m = getRunManifest(p.runId);
      if (!m) throw httpErr(404, `run ${p.runId} not found`);
      return m;
    },
  },

  {
    method: "GET", pattern: "/api/runs/:runId/per_patient/:patientId/drafts",
    handler: async (_b, _r, p) => {
      const dir = path.join(perPatientDir(p.runId, p.patientId), "agents");
      if (!fs.existsSync(dir)) return { drafts: [] };
      const provider = getRunManifest(p.runId)?.provider;
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
      return { drafts };
    },
  },

  {
    method: "GET", pattern: "/api/runs/:runId/status",
    handler: async (_b, _r, p) => {
      const s = getRunStatus(p.runId);
      if (!s) throw httpErr(404, "run not found");
      return s;
    },
  },

  {
    method: "GET", pattern: "/api/runs/:runId/patients/:patientId/draft",
    handler: async (_b, _r, p) => {
      const d = readRunDraft(p.runId, p.patientId);
      if (d === null) throw httpErr(404, "draft not found");
      return d;
    },
  },

  {
    method: "GET", pattern: "/api/runs/:runId/patients/:patientId/audit",
    handler: async (_b, _r, p) => {
      // Audit log locations:
      //   In-flight (per agent): <runDir>/_scratch_state_<agentId>/<pid>/<taskId>/chat/*.jsonl
      //   Final (after completion): <runDir>/per_patient/<pid>/agents/<agentId>_audit/*.jsonl
      //   Legacy: <runDir>/per_patient/<pid>/audit.jsonl
      // Merge everything we can find and sort by ts. Dedupe duplicate
      // lines (running runs may have the same record in both places once
      // the post-run copy fires).
      const runDirPath = path.join(runsRoot(), p.runId);
      const baseDir = perPatientDir(p.runId, p.patientId);
      const merged = new Set<string>();

      const pushFile = (filePath: string) => {
        try {
          const text = fs.readFileSync(filePath, "utf8");
          for (const line of text.split("\n")) {
            const t = line.trim();
            if (t.length > 0) merged.add(t);
          }
        } catch { /* skip unreadable */ }
      };

      // (1) In-flight: scan _scratch_state_<agentId> dirs.
      if (fs.existsSync(runDirPath)) {
        for (const entry of fs.readdirSync(runDirPath)) {
          if (!entry.startsWith("_scratch_state_")) continue;
          const scratchPatientDir = path.join(runDirPath, entry, p.patientId);
          if (!fs.existsSync(scratchPatientDir)) continue;
          // <pid>/<taskId>/chat/*.jsonl — taskId varies, so walk one level.
          for (const taskDir of fs.readdirSync(scratchPatientDir)) {
            const chatDir = path.join(scratchPatientDir, taskDir, "chat");
            if (!fs.existsSync(chatDir)) continue;
            for (const file of fs.readdirSync(chatDir)) {
              if (file.endsWith(".jsonl")) pushFile(path.join(chatDir, file));
            }
          }
        }
      }

      // (2) Final per-agent audit dirs.
      const agentsDir = path.join(baseDir, "agents");
      if (fs.existsSync(agentsDir)) {
        for (const entry of fs.readdirSync(agentsDir)) {
          if (!entry.endsWith("_audit")) continue;
          const dir = path.join(agentsDir, entry);
          if (!fs.statSync(dir).isDirectory()) continue;
          for (const file of fs.readdirSync(dir)) {
            if (file.endsWith(".jsonl")) pushFile(path.join(dir, file));
          }
        }
      }

      // (3) Legacy singular audit.jsonl.
      const legacy = path.join(baseDir, "audit.jsonl");
      if (fs.existsSync(legacy)) pushFile(legacy);

      if (merged.size === 0) throw httpErr(404, "audit not found");

      const lines = Array.from(merged).sort((a, b) => {
        try {
          const ta = (JSON.parse(a) as { ts?: string }).ts ?? "";
          const tb = (JSON.parse(b) as { ts?: string }).ts ?? "";
          return ta.localeCompare(tb);
        } catch { return 0; }
      });

      const raw: RawBody = {
        __raw: true,
        contentType: "application/x-ndjson",
        body: lines.join("\n") + "\n",
      };
      return raw;
    },
  },

  {
    method: "DELETE", pattern: "/api/runs/:runId",
    handler: async (_b, req, p) => {
      gateMethodologist(req, "deleting a run");
      try {
        const ok = deleteRun(p.runId);
        if (!ok) throw httpErr(404, "run not found");
        return { ok: true };
      } catch (e) {
        if ((e as { status?: number }).status) throw e;
        throw httpErr(409, (e as Error).message);
      }
    },
  },
];
