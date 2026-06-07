// M6 — Boot-critical "core" routes ported from v1's server.ts.
//
// Routes the UI hits on initial page load. Porting these so v2 can
// serve the Studio without v1 running. The long tail (codify, methods
// drafter, authoring, calibration, audit-trail, bundle export, etc.)
// stays proxied to v1 for now.
//
// Endpoints:
//   GET /api/runtime                              — header info + auth mode
//   GET /api/tasks                                — task listing
//   GET /api/tasks/:id                            — task detail
//   GET /api/patients                             — patient list (?task_id= enriches)
//   GET /api/patients/:id/notes                   — note listing
//   GET /api/patients/:id/notes/:filename         — note content (text/plain)
//   GET /api/patients/:id/structured              — structured data
//   GET /api/patients/:id/messages                — chat messages

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry, RouteHandler } from "./router.js";
import { authMode } from "./auth.js";
import {
  listPatients, listNotes, readNote, readStructured,
} from "./lib/patients.js";
import { chatStore } from "./lib/chat-store.js";
import {
  listCompiledTasks, loadCompiledTask,
} from "./lib/tasks.js";
import { modelFor } from "./lib/model-config.js";
import { defaultProviderName } from "@chart-review/agent-provider";
import { pathFor as storagePathFor } from "@chart-review/storage";

function reviewStatePath(sessionId: string, patientId: string, taskId: string): string {
  return storagePathFor.reviewState(sessionId, patientId, taskId);
}

const DEFAULT_TASK_ID =
  process.env.CHART_REVIEW_TASK_ID ?? "lung-cancer-phenotype";

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

/** Marker that tells the response writer "this is a text/plain body,
 *  not JSON." server/index.ts unwraps it when present.
 *
 *  `body` may be either:
 *    - a string (default; written as-is with the declared content-type)
 *    - a Buffer (binary; written without UTF-8 re-encoding — required
 *      for gzip / tar / png / pdf and any other binary download).
 */
export interface RawBody {
  __raw: true;
  contentType: string;
  body: string | Buffer;
}

/** Marker that tells the response writer "this is an SSE stream — pump
 *  the generator into the response and don't touch the content-type or
 *  call res.end yourself." Used for prelock-summary/stream and
 *  suggest-override-reason/stream. */
export interface SSEStream {
  __sse: true;
  generator: AsyncGenerator<unknown, void, void>;
}

export const coreRoutes: RouteEntry[] = [
  // GET /api/runtime — header info
  {
    method: "GET", pattern: "/api/runtime",
    handler: async () => ({
      model: modelFor("default") ?? "(unset)",
      base_url: process.env.ANTHROPIC_BASE_URL ?? "(default — direct anthropic)",
      default_task_id: DEFAULT_TASK_ID,
      auth_mode: authMode(),
      reviewers: process.env.REVIEWERS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
      // Which agent runtime backs iters that use an agent loop
      // (phenotype, adherence). NER bypasses this — it calls Azure
      // /responses directly with no agent runtime.
      agent_provider: defaultProviderName(),
    }),
  },

  // GET /api/tasks
  {
    method: "GET", pattern: "/api/tasks",
    handler: async () => listCompiledTasks().map((t) => ({
      task_id: t.task_id,
      task_type: t.task_type,
      manual_version: t.manual_version,
      field_count: t.fields.length,
      final_output: t.final_output,
    })),
  },

  // GET /api/tasks/:id
  {
    method: "GET", pattern: "/api/tasks/:id",
    handler: async (_b, _r, p) => {
      const t = loadCompiledTask(p.id);
      if (!t) throw httpErr(404, "task not found");
      return t;
    },
  },

  // GET /api/patients — optional ?task_id= enriches with review-state metadata.
  //
  // For NER tasks (Phase 4.5), `review_status` is *derived* from the
  // span_labels array rather than read from the top-level field —
  // because no code path currently flips the top-level status as
  // individual spans get validated via PATCH /spans/:spanId. Derivation:
  //   - explicit `review_status: "locked"` wins
  //   - no spans                    → "agent_proposed" (or whatever the file says)
  //   - any span lacks a terminal status (mapped/rejected) → "in_progress"
  //   - all spans terminal          → "reviewer_validated"
  {
    method: "GET", pattern: "/api/patients",
    handler: async (_b, _r, _p, query) => {
      const taskId = query.get("task_id");
      const sessionId = query.get("session_id");
      const patients = listPatients();
      // Without a task_id we can't read review state — return bare list.
      // Without a session_id there is no per-session scope to read from —
      // also return the bare list (no flat-path fallback, no crash).
      if (!taskId || !sessionId) return patients;
      return patients.map((pt) => {
        // Use the canonical pathFor (resolves to var/reviews/<sessionId>/)
        // so review state is scoped to the active session.
        const rsPath = reviewStatePath(sessionId, pt.patient_id, taskId);
        if (!fs.existsSync(rsPath)) return pt;
        try {
          const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
            assigned_to?: string[];
            review_status?: string;
            task_kind?: string;
            span_labels?: Array<{ status?: string }>;
            field_assessments?: unknown[];
          };
          return { ...pt, assigned_to: rs.assigned_to, review_status: rs.review_status };
        } catch { return pt; }
      });
    },
  },

  // GET /api/patients/:id/notes
  {
    method: "GET", pattern: "/api/patients/:id/notes",
    handler: async (_b, _r, p) => {
      try { return listNotes(p.id); }
      catch (e) { throw httpErr(400, (e as Error).message); }
    },
  },

  // GET /api/patients/:id/notes/:filename — returns raw text
  {
    method: "GET", pattern: "/api/patients/:id/notes/:filename",
    handler: (async (_b, _r, p) => {
      try {
        const text = readNote(p.id, p.filename);
        const raw: RawBody = { __raw: true, contentType: "text/plain; charset=utf-8", body: text };
        return raw;
      } catch (e) {
        throw httpErr(404, (e as Error).message);
      }
    }) as RouteHandler,
  },

  // GET /api/patients/:id/structured
  {
    method: "GET", pattern: "/api/patients/:id/structured",
    handler: async (_b, _r, p) => {
      try { return readStructured(p.id); }
      catch (e) { throw httpErr(400, (e as Error).message); }
    },
  },

  // GET /api/patients/:id/messages
  {
    method: "GET", pattern: "/api/patients/:id/messages",
    handler: async (_b, _r, p) => chatStore.getMessages(p.id),
  },
];
