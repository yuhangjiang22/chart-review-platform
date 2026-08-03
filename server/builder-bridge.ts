// M7.4 — Builder bridge. The builder subsystem in v1 was written
// against Express + multer; porting each of its 12 routes individually
// would duplicate code unnecessarily. v2 keeps its raw Node http core
// for the main route surface and delegates anything matching
// /api/builder/* to a sub-mounted Express app whose router is the
// vendored registerBuilderRoutes() from lib/builder-routes.js.
//
// WebSocket upgrades for /api/builder/sessions/:taskId/stream are
// handled by a second WebSocketServer (wssBuilder) that wraps the
// vendored BuilderSession from lib/builder-session.js.

import express from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { registerBuilderRoutes } from "./lib/builder-routes.js";
import { getOrCreateBuilderSession } from "./lib/builder-session.js";
import { resolveToken } from "./lib/auth.js";

type WSClient = WebSocket & { reviewer_id?: string };

// ── HTTP delegation ──────────────────────────────────────────────────
const app = express();
registerBuilderRoutes(app);

/** Does the request path belong to the builder subsystem? */
export function isBuilderPath(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("/api/builder/");
}

/** Hand the request off to the Express sub-app. */
export function delegateBuilder(req: IncomingMessage, res: ServerResponse): void {
  app(req, res);
}

// ── WebSocket delegation ─────────────────────────────────────────────
const wssBuilder = new WebSocketServer({ noServer: true });

wssBuilder.on("connection", (ws: WSClient, req: IncomingMessage) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const token = url.searchParams.get("token");
  const reviewerId = resolveToken(token) ?? "anonymous-reviewer";
  ws.reviewer_id = reviewerId;

  const match = url.pathname.match(/^\/api\/builder\/sessions\/([^/]+)\/stream$/);
  if (!match) { ws.close(4404, "not found"); return; }
  const taskId = match[1];
  const session = getOrCreateBuilderSession(taskId, reviewerId);
  (session as unknown as { subscribe: (ws: WSClient) => void }).subscribe(ws);

  ws.on("message", (raw) => {
    let msg: { type?: string; content?: string };
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }
    if (msg.type === "user_message" && typeof msg.content === "string") {
      (session as unknown as { sendUserMessage: (s: string) => void }).sendUserMessage(msg.content);
    }
  });
});

export function isBuilderUpgradePath(url: string | undefined): boolean {
  if (!url) return false;
  return /^\/api\/builder\/sessions\/[^/]+\/stream/.test(url);
}

export function handleBuilderUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  wssBuilder.handleUpgrade(req, socket, head, (ws) => {
    wssBuilder.emit("connection", ws, req);
  });
}
