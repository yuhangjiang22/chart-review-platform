// POST /api/ner-sdk/run {session_id}  — spawn the vendored Claude-Agent-SDK NER
// run (scripts/run-bso-ad-claude-sdk.ts) DETACHED, return immediately.
// GET  /api/ner-sdk/run-status?session_id=…  — read its status file.
// Dedicated channel for the bso-ad-ner-sdk task; does NOT touch pilot/batch.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";

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

function statusPath(sessionId: string): string {
  return path.join(PLATFORM_ROOT, "var", "benchmark-sdk", sessionId, "status.json");
}

export const nerSdkRunRoutes: RouteEntry[] = [
  {
    method: "POST",
    pattern: "/api/ner-sdk/run",
    handler: async (body) => {
      const sessionId = safeSessionId((body as { session_id?: unknown } | null)?.session_id);
      const sf = statusPath(sessionId);
      const dir = path.dirname(sf);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(sf, JSON.stringify({ state: "starting", session_id: sessionId }, null, 2));
      const logFd = fs.openSync(path.join(dir, "run.log"), "a");
      const child = spawn(
        "npx",
        ["tsx", "scripts/run-bso-ad-claude-sdk.ts", "--session-id", sessionId, "--status-file", sf],
        { cwd: PLATFORM_ROOT, detached: true, stdio: ["ignore", logFd, logFd] },
      );
      child.unref();
      return { started: true, session_id: sessionId };
    },
  },
  {
    method: "GET",
    pattern: "/api/ner-sdk/run-status",
    handler: async (_b, _r, _p, query) => {
      const sessionId = safeSessionId(query.get("session_id"));
      const sf = statusPath(sessionId);
      if (!fs.existsSync(sf)) return { state: "idle", session_id: sessionId };
      try {
        return JSON.parse(fs.readFileSync(sf, "utf-8"));
      } catch {
        return { state: "running", session_id: sessionId };
      }
    },
  },
];
