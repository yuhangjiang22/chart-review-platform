// M6.2 — Notifications, agent-roles, diagnostics routes ported from v1.
//
// All three are read-mostly + boot-critical (NotificationsBell polls
// at startup; AgentConfigPanel reads presets; diagnostics page reads
// model routing).
//
// Endpoints:
//   GET    /api/notifications                  — list (?limit, ?unread)
//   GET    /api/notifications/unread-count
//   POST   /api/notifications/mark-read        — { ids? | all? }
//   GET    /api/agent-roles                    — extractor presets
//   GET    /api/agent-roles/default-model      — default model id
//   GET    /api/diagnostics/models             — every feature's resolved model

import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import {
  listNotifications, unreadCount, markRead, markAllRead,
} from "./lib/notifications.js";
import { listAvailablePresets } from "./lib/agent-specs.js";
import {
  modelFor, describeAllModels,
} from "./lib/model-config.js";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export const miscRoutes: RouteEntry[] = [
  // ── /api/notifications/* ────────────────────────────────────────────
  {
    method: "GET", pattern: "/api/notifications",
    handler: async (_b, req, _p, query) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const unreadParam = query.get("unread");
      const unreadOnly = unreadParam === "1" || unreadParam === "true";
      const limitStr = query.get("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;
      return listNotifications(reviewerId, {
        unreadOnly, limit,
        includeMethodologistBroadcast: isMethodologist(reviewerId),
      });
    },
  },

  {
    method: "GET", pattern: "/api/notifications/unread-count",
    handler: async (_b, req) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      return {
        count: unreadCount(reviewerId, {
          includeMethodologistBroadcast: isMethodologist(reviewerId),
        }),
      };
    },
  },

  {
    method: "POST", pattern: "/api/notifications/mark-read",
    handler: async (body, req) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const { ids, all } = (body ?? {}) as { ids?: string[]; all?: boolean };
      if (all) markAllRead(reviewerId);
      else if (Array.isArray(ids)) markRead(reviewerId, ids);
      else throw httpErr(400, "ids[] or all:true required");
      return { ok: true };
    },
  },

  // ── /api/agent-roles ────────────────────────────────────────────────
  {
    method: "GET", pattern: "/api/agent-roles",
    handler: async () => ({
      presets: listAvailablePresets().map((p) => ({
        preset_id: p.preset_id,
        preset_version: p.preset_version,
        axis: p.axis ?? null,
        role_prompt: p.role_prompt,
      })),
    }),
  },

  {
    method: "GET", pattern: "/api/agent-roles/default-model",
    handler: async () => ({ default_model: modelFor("default") ?? null }),
  },

  // ── /api/diagnostics/models ─────────────────────────────────────────
  {
    method: "GET", pattern: "/api/diagnostics/models",
    handler: async () => ({ models: describeAllModels() }),
  },
];
