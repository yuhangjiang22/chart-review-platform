// Folder-pick deploy routes — the simple deployment path.
//
//   POST /api/deploy/:taskId/scan    — preview folder layout
//   POST /api/deploy/:taskId/run     — symlink + start batch run, return run_id
//
// Auth: methodologist-only. The endpoint touches the corpus filesystem
// and starts an LLM batch run, so both an authn token and the
// methodologist privilege are required (same gate as POST /api/pilots).

import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import { loadCompiledTask } from "./lib/tasks.js";
import {
  scanDeployFolder, ingestDeployFolder, makeDeployId, cleanupDeployFolder,
} from "./lib/deploy-folder.js";
import { startBatchRun } from "./lib/infra/batch-run/index.js";
import { broadcastRunUpdate } from "./ws.js";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function gateMethodologist(req: Parameters<RouteEntry["handler"]>[1], action: string): string {
  const reviewerId = readReviewerFromRequest(req);
  if (reviewerId === null) {
    throw httpErr(401, "Authorization required. POST /api/auth/login first.");
  }
  if (!isMethodologist(reviewerId)) {
    throw httpErr(403, `${action} requires methodologist privilege`);
  }
  return reviewerId;
}

export const deployRoutes: RouteEntry[] = [
  // POST /api/deploy/:taskId/scan
  // Preview a folder: confirm it exists, list the patient subdirs and
  // note counts. Read-only — no symlinks, no run.
  {
    method: "POST", pattern: "/api/deploy/:taskId/scan",
    handler: async (body, req, p) => {
      gateMethodologist(req, "scanning a deploy folder");
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      const { folder_path } = (body ?? {}) as { folder_path?: string };
      if (!folder_path) throw httpErr(400, "folder_path required");
      const result = scanDeployFolder(folder_path);
      if (!result.ok) throw httpErr(400, result.error);
      return result;
    },
  },

  // POST /api/deploy/:taskId/run
  // Symlink the folder's patient subdirs into the corpus under a
  // deploy_<id>_ namespace, then start a batch run against the task.
  // Returns the new run_id and the patient_ids that were ingested.
  // Cleanup of the symlinks is a separate step (the patients are
  // useful in the UI while the reviewer inspects results).
  {
    method: "POST", pattern: "/api/deploy/:taskId/run",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "running a deploy");
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      const {
        folder_path, label, max_concurrency, max_turns_per_patient,
        cost_cap_usd, agent_specs, deploy_id_seed,
      } = (body ?? {}) as {
        folder_path?: string;
        label?: string;
        max_concurrency?: number;
        max_turns_per_patient?: number;
        cost_cap_usd?: number;
        agent_specs?: Parameters<typeof startBatchRun>[0]["agent_specs"];
        /** Caller-supplied timestamp string. The deploy_id is purely
         *  cosmetic (used only in the patient_id prefix). When omitted,
         *  the route stamps one server-side. */
        deploy_id_seed?: string;
      };
      if (!folder_path) throw httpErr(400, "folder_path required");

      const deploy_id = makeDeployId(deploy_id_seed ?? new Date().toISOString());
      const ingest = ingestDeployFolder({ folder_path, deploy_id });
      if (!ingest.ok) throw httpErr(400, ingest.error);
      if (ingest.patient_ids.length === 0) {
        throw httpErr(400, `no patients ingested from ${folder_path} (all subdirs missing notes/ or empty)`);
      }
      try {
        const result = startBatchRun({
          task_id: p.taskId,
          patient_ids: ingest.patient_ids,
          started_by: reviewerId,
          label: label ?? `deploy-${deploy_id}`,
          max_concurrency, max_turns_per_patient, cost_cap_usd,
          agent_specs,
          onStatus: broadcastRunUpdate,
        });
        return {
          ok: true,
          deploy_id,
          run_id: result.run_id,
          patient_ids: ingest.patient_ids,
          symlinked: ingest.symlinked,
          skipped: ingest.skipped,
        };
      } catch (e) {
        // Roll back the symlinks if startBatchRun bombed — otherwise
        // the patient list gets cluttered with dead deploy_ entries.
        cleanupDeployFolder(deploy_id);
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  // POST /api/deploy/:taskId/cleanup
  // Remove the symlinks created by a previous deploy. Optional —
  // methodologists can keep them around to browse the deploy patients
  // in the patient list, or call cleanup to declutter.
  {
    method: "POST", pattern: "/api/deploy/:taskId/cleanup",
    handler: async (body, req) => {
      gateMethodologist(req, "cleaning up a deploy");
      const { deploy_id } = (body ?? {}) as { deploy_id?: string };
      if (!deploy_id) throw httpErr(400, "deploy_id required");
      if (!/^deploy_[A-Za-z0-9_-]+$/.test(deploy_id)) {
        throw httpErr(400, "invalid deploy_id");
      }
      return { ok: true, ...cleanupDeployFolder(deploy_id) };
    },
  },
];
