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

import fs from "node:fs";
import path from "node:path";
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

  // ── /api/diagnostics/api-providers ──────────────────────────────────
  //
  // Read-only summary of the platform's API-provider config: which
  // agent provider is active (Claude/Codex), what models are picked,
  // whether the relevant API keys are set in the environment, and —
  // for the Codex path — what [model_providers.X] blocks are
  // declared in .codex/config.toml. Returns only PRESENCE booleans
  // for secrets ("ANTHROPIC_API_KEY: set" or "unset"), never the
  // values themselves.
  {
    method: "GET", pattern: "/api/diagnostics/api-providers",
    handler: async () => buildApiProviderDiagnostics(),
  },
];

/** Build the diagnostics payload — synchronous file read on the
 *  codex config (small, no async needed). Defensive: returns
 *  partial data if config.toml is missing / malformed instead of
 *  failing the whole endpoint. */
function buildApiProviderDiagnostics() {
  const activeProvider = (process.env.AGENT_PROVIDER ?? "claude").toLowerCase();
  const claude = {
    model: modelFor("default") ?? null,
    base_url: process.env.ANTHROPIC_BASE_URL ?? null,
    api_key_present: !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN,
    api_key_env_name: process.env.ANTHROPIC_API_KEY
      ? "ANTHROPIC_API_KEY"
      : process.env.ANTHROPIC_AUTH_TOKEN
        ? "ANTHROPIC_AUTH_TOKEN"
        : null,
  };
  const codex = readCodexProviderConfig();
  return {
    ok: true,
    active_provider: activeProvider,
    claude,
    codex,
  };
}

interface CodexProviderConfig {
  config_path: string | null;
  config_present: boolean;
  /** Top-level `model = ...` */
  active_model: string | null;
  /** Top-level `model_provider = ...` */
  active_provider: string | null;
  /** `model_reasoning_effort = ...` */
  reasoning_effort: string | null;
  /** Every [model_providers.X] block found, with its base_url + env_key
   *  + whether that env_key is currently set. */
  available_providers: Array<{
    id: string;
    name?: string;
    base_url?: string;
    wire_api?: string;
    env_key?: string;
    env_key_present?: boolean;
  }>;
  /** CODEX_HOME the platform spawns codex against (project-local override). */
  codex_home: string;
}

function readCodexProviderConfig(): CodexProviderConfig {
  const codexHome = process.env.CHART_REVIEW_CODEX_HOME
    ?? path.join(process.env.CHART_REVIEW_PLATFORM_ROOT ?? process.cwd(), ".codex");
  const cfgPath = path.join(codexHome, "config.toml");
  const out: CodexProviderConfig = {
    config_path: cfgPath,
    config_present: false,
    active_model: null,
    active_provider: null,
    reasoning_effort: null,
    available_providers: [],
    codex_home: codexHome,
  };
  if (!fs.existsSync(cfgPath)) return out;
  out.config_present = true;
  let raw: string;
  try { raw = fs.readFileSync(cfgPath, "utf8"); }
  catch { return out; }

  // Minimal TOML parsing — we only need three top-level scalar
  // assignments + the [model_providers.X] sections. A full toml parser
  // is overkill for a read-only diagnostics view and would pull a
  // dependency we don't otherwise need.
  const topModel = /^[ \t]*model[ \t]*=[ \t]*"([^"]+)"/m.exec(raw);
  const topProvider = /^[ \t]*model_provider[ \t]*=[ \t]*"([^"]+)"/m.exec(raw);
  const topEffort = /^[ \t]*model_reasoning_effort[ \t]*=[ \t]*"([^"]+)"/m.exec(raw);
  if (topModel) out.active_model = topModel[1] ?? null;
  if (topProvider) out.active_provider = topProvider[1] ?? null;
  if (topEffort) out.reasoning_effort = topEffort[1] ?? null;

  // Walk [model_providers.X] sections.
  const sectionRe = /\[model_providers\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=^\[|$(?![\r\n]))/gm;
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(raw)) !== null) {
    const id = m[1]!;
    const body = m[2] ?? "";
    const grab = (k: string): string | undefined =>
      new RegExp(`^[ \\t]*${k}[ \\t]*=[ \\t]*"([^"]+)"`, "m").exec(body)?.[1];
    const envKey = grab("env_key");
    out.available_providers.push({
      id,
      name: grab("name"),
      base_url: grab("base_url"),
      wire_api: grab("wire_api"),
      env_key: envKey,
      env_key_present: envKey ? !!process.env[envKey] : undefined,
    });
  }
  return out;
}
