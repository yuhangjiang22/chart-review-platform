// POST /api/ner-sdk/run {session_id}  — spawn the vendored Claude-Agent-SDK NER
// run (scripts/run-bso-ad-claude-sdk.ts) DETACHED, return immediately.
// GET  /api/ner-sdk/run-status?session_id=…  — read its status file.
// Dedicated channel for the bso-ad-ner-sdk task; does NOT touch pilot/batch.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { getSessionManifest } from "@chart-review/domain-iter";

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

function safeSessionId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) {
    throw httpErr(400, "session_id must be a simple identifier");
  }
  return v;
}

// task_id defaults to the vendored-SDK NER task for back-compat with callers
// that predate task scoping.
function safeTaskId(v: unknown): string {
  if (v == null) return "bso-ad-ner-sdk";
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) {
    throw httpErr(400, "task_id must be a simple identifier");
  }
  return v;
}

// Namespaced by task AND session: two NER tasks can share a session_id, so a
// session-only status key made their runs collide (one task's run status showed
// up under the other's session view).
function statusPath(taskId: string, sessionId: string): string {
  return path.join(PLATFORM_ROOT, "var", "benchmark-sdk", taskId, sessionId, "status.json");
}

export const nerSdkRunRoutes: RouteEntry[] = [
  {
    method: "POST",
    pattern: "/api/ner-sdk/run",
    handler: async (body) => {
      const b = (body ?? {}) as { session_id?: unknown; task_id?: unknown };
      const sessionId = safeSessionId(b.session_id);
      const taskId = safeTaskId(b.task_id);
      const sf = statusPath(taskId, sessionId);
      const dir = path.dirname(sf);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(sf, JSON.stringify({ state: "starting", task_id: taskId, session_id: sessionId }, null, 2));
      const logFd = fs.openSync(path.join(dir, "run.log"), "a");
      // Honor the session's configured agent model. Without this the harness
      // default (gpt-5.2) runs regardless of what the UI shows, so the run
      // silently uses a different model than the session's agent_spec.
      const spec = getSessionManifest(taskId, sessionId)?.agent_specs?.[0] as { model?: string } | undefined;
      const model = spec?.model;
      const args = ["tsx", "scripts/run-bso-ad-claude-sdk.ts", "--task-id", taskId, "--session-id", sessionId, "--status-file", sf];
      // Allow "/" so provider-namespaced ids (e.g. OpenRouter "anthropic/claude-sonnet-4.6",
      // "openai/gpt-4o") pass through. Without it the flag is dropped and the run
      // silently falls back to the harness default model.
      if (typeof model === "string" && /^[A-Za-z0-9._/-]+$/.test(model)) args.push("--model", model);
      const child = spawn(
        "npx",
        args,
        { cwd: PLATFORM_ROOT, detached: true, stdio: ["ignore", logFd, logFd] },
      );
      child.unref();
      return { started: true, task_id: taskId, session_id: sessionId };
    },
  },
  {
    method: "GET",
    pattern: "/api/ner-sdk/run-status",
    handler: async (_b, _r, _p, query) => {
      const sessionId = safeSessionId(query.get("session_id"));
      const taskId = safeTaskId(query.get("task_id"));
      const sf = statusPath(taskId, sessionId);
      if (!fs.existsSync(sf)) return { state: "idle", task_id: taskId, session_id: sessionId };
      try {
        return JSON.parse(fs.readFileSync(sf, "utf-8"));
      } catch {
        return { state: "running", session_id: sessionId };
      }
    },
  },
];
