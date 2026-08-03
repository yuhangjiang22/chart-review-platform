// Workflow phase configuration routes.
//
// GET   /api/tasks/:taskId/phases     resolved enabled-phase list for a task
// PATCH /api/tasks/:taskId/phases     update meta.yaml phases list (methodologist)
//
// Phase registration: imports each @chart-review/workflow-phase-<id>
// at module load, which call registerPhase() on @chart-review/workflow-phases.
// After this module loads, allPhases() returns the canonical 7.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import { guidelineDir } from "@chart-review/rubric";
import {
  registerPhase, resolvePhasesForTask, allPhases, type PhaseId, type PhaseModule,
} from "@chart-review/workflow-phases";

// Register the phase modules at boot.
import PHASE_AUTHOR from "@chart-review/workflow-phase-author";
import PHASE_TRY from "@chart-review/workflow-phase-try";
import PHASE_JUDGE from "@chart-review/workflow-phase-judge";
import PHASE_VALIDATE from "@chart-review/workflow-phase-validate";
import PHASE_DECIDE from "@chart-review/workflow-phase-decide";
import PHASE_LOCK from "@chart-review/workflow-phase-lock";
import PHASE_DEPLOY from "@chart-review/workflow-phase-deploy";

// REFINE — the git-like refinement workspace (working-draft diff + version
// history + proposals). Defined inline (no behavior package): it's a UI tab whose
// React view lives in client/src/ui/Workspace. required:true so it's always
// available as a tab, regardless of a task's meta.yaml phases list.
const PHASE_REFINE: PhaseModule = {
  id: "refine",
  label: "Refine",
  slug: "refine",
  group: "iter",
  optional: false,
  required: true,
  description:
    "Review the working draft (diffs vs the last saved version), apply refinement proposals, and save or switch rubric versions.",
  enabledByDefault: true,
};

for (const mod of [PHASE_AUTHOR, PHASE_TRY, PHASE_JUDGE, PHASE_VALIDATE, PHASE_DECIDE, PHASE_REFINE, PHASE_LOCK, PHASE_DEPLOY]) {
  registerPhase(mod);
}

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function readMetaYaml(taskId: string): { meta: Record<string, unknown>; metaPath: string } {
  const dir = guidelineDir(taskId);
  const metaPath = path.join(dir, "meta.yaml");
  if (!fs.existsSync(metaPath)) throw httpErr(404, `no meta.yaml for task ${taskId}`);
  const meta = parseYaml(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
  return { meta: meta ?? {}, metaPath };
}

export const phasesRoutes: RouteEntry[] = [
  // GET /api/tasks/:taskId/phases — resolved list (id + metadata)
  {
    method: "GET", pattern: "/api/tasks/:taskId/phases",
    handler: async (_b, _r, p) => {
      let cfg: PhaseId[] | undefined;
      try {
        const { meta } = readMetaYaml(p.taskId);
        if (Array.isArray(meta.phases)) cfg = meta.phases as PhaseId[];
      } catch { /* task w/o meta.yaml falls through to defaults */ }
      const resolved = resolvePhasesForTask({ phases: cfg });
      return {
        task_id: p.taskId,
        configured: cfg ?? null,             // null means using defaults
        enabled: resolved.map((m) => m.id),  // ids only — UI knows the rest
        registry: allPhases(),               // full metadata for every phase
      };
    },
  },

  // PATCH /api/tasks/:taskId/phases — set the phases list (methodologist)
  {
    method: "PATCH", pattern: "/api/tasks/:taskId/phases",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!isMethodologist(reviewerId)) {
        throw httpErr(403, "editing task phases requires methodologist privilege");
      }
      const next = (body as { phases?: unknown })?.phases;
      if (!Array.isArray(next)) throw httpErr(400, "phases must be an array of phase ids");
      const valid = new Set(allPhases().map((m) => m.id));
      const bad = (next as string[]).filter((id) => !valid.has(id as PhaseId));
      if (bad.length > 0) {
        throw httpErr(400, `unknown phase id(s): ${bad.join(", ")}`);
      }
      // Required phases must be present.
      const requiredMissing = allPhases()
        .filter((m) => m.required)
        .filter((m) => !(next as string[]).includes(m.id))
        .map((m) => m.id);
      if (requiredMissing.length > 0) {
        throw httpErr(400, `required phases cannot be disabled: ${requiredMissing.join(", ")}`);
      }
      const { meta, metaPath } = readMetaYaml(p.taskId);
      meta.phases = next;
      fs.writeFileSync(metaPath, stringifyYaml(meta));
      const resolved = resolvePhasesForTask({ phases: next as PhaseId[] });
      return { ok: true, configured: next, enabled: resolved.map((m) => m.id) };
    },
  },
];
