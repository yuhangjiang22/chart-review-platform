// maturity-derived-routes.ts — two GET endpoints whose server logic exists but
// whose routes were never mounted in concur, so the client got 404s on every
// workspace load (maturity) and every patient-review load (derived-adjudications).
// Both back real features; this just exposes them.
//
//   GET /api/guidelines/:taskId/maturity
//     → the task's MaturityRecord ({ task_id, state, transitions, … }). Drives
//       the phase-bar "done" checkmarks + workflow banner. getMaturity already
//       defaults to {state:"draft"} when no maturity file exists.
//
//   GET /api/reviews/:patientId/:taskId/derived-adjudications
//     → { ok, records, iter_id } — the judge-derived per-field feedback the
//       review pane's FeedbackStrip shows. iter_id is resolved from the patient's
//       most-recent pilot (the lock-helpers were written for exactly this route,
//       per their doc comment), so the client doesn't pass it on the wire.

import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { getMaturity } from "./lib/maturity.js";
import {
  findActiveIterIdForPatient,
  resolvePilotIterDirFromIterId,
} from "./lib/derived-adjudications/lock-helpers.js";
import { findDerivedAdjudicationsForPatient } from "./lib/derived-adjudications/store.js";

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

export const maturityDerivedRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/guidelines/:taskId/maturity",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      return getMaturity(p.taskId);
    },
  },

  {
    method: "GET",
    pattern: "/api/reviews/:patientId/:taskId/derived-adjudications",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      const iterId = findActiveIterIdForPatient(p.taskId, p.patientId);
      if (!iterId) return { ok: true, records: [], iter_id: null };
      const dir = resolvePilotIterDirFromIterId(iterId);
      if (!dir) return { ok: true, records: [], iter_id: iterId };
      return {
        ok: true,
        records: findDerivedAdjudicationsForPatient(dir, p.patientId),
        iter_id: iterId,
      };
    },
  },
];
