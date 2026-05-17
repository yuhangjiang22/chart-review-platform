// WebSocket server for v2 — replaces the proxy to v1's :3001/ws.
//
// Responsibilities:
//   1. /ws upgrade: auth via ?token=, send "connected" handshake,
//      heartbeat ping/pong.
//   2. Handle "subscribe" / "chat" client messages by routing them to
//      a per-(patient, task, blindMode) Session (vendored from v1 in
//      lib/session.ts).
//   3. Expose broadcasters for run-status, job-status, and
//      review-state updates so REST endpoints can push events.
//
// Patterns from v1's app/server/server.ts:
//   - In-memory `sessions` Map keyed by patient + task + blindMode.
//   - Connection-level reviewer_id + isAlive heartbeat fields.
//   - Subscribers Set on the Session (private field; we use brackets).

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  authMode, resolveToken,
} from "./lib/auth.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { chatStore } from "./lib/chat-store.js";
import { Session } from "./lib/session.js";
import type { ReviewState } from "./lib/domain/review/index.js";
import type { RunStatus } from "./lib/infra/batch-run/index.js";
import {
  getJobStatus, getJobManifest,
} from "./lib/jobs.js";
import {
  maybeAutoAdvancePilotOnRunStatus,
} from "./lib/domain/iter/index.js";
import { getRunManifest } from "./lib/infra/batch-run/index.js";
import { transitionMaturity, getMaturity } from "@chart-review/maturity";

/** When a run hits a terminal state, auto-advance the task's maturity
 *  from "draft" to "piloted" — at least one pilot has now run. Idempotent
 *  and best-effort; failures swallowed so they don't break the WS
 *  broadcast. */
function maybeAutoAdvanceMaturityOnRunComplete(status: RunStatus): void {
  try {
    const TERMINAL = new Set(["complete", "failed", "error", "cancelled"]);
    if (!TERMINAL.has(status.state)) return;
    const manifest = getRunManifest(status.run_id);
    if (!manifest?.task_id) return;
    const cur = getMaturity(manifest.task_id);
    if (cur.state === "draft" && status.state === "complete") {
      transitionMaturity(manifest.task_id, "piloted", "auto-advance:pilot-complete");
    }
  } catch {
    // best-effort — never propagate
  }
}

type WSClient = WebSocket & {
  reviewer_id?: string;
  isAlive?: boolean;
};

interface IncomingWSMessage {
  type: "subscribe" | "chat" | string;
  patientId?: string;
  taskId?: string;
  blindMode?: boolean;
  content?: string;
}

const DEFAULT_TASK_ID =
  process.env.CHART_REVIEW_TASK_ID ?? "lung-cancer-phenotype";

// One Session per (patient, task, blindMode). Lazy-init on first
// subscribe; cached for the lifetime of the process.
const sessions = new Map<string, Session>();

function sessionKey(patientId: string, taskId: string, blindMode?: boolean): string {
  return `${patientId}::${taskId}::${blindMode ? "blind" : "normal"}`;
}

function getOrCreateSession(patientId: string, taskId: string, blindMode?: boolean): Session {
  const key = sessionKey(patientId, taskId, blindMode);
  let session = sessions.get(key);
  if (!session) {
    const task = loadCompiledTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    session = new Session(patientId, task, blindMode);
    sessions.set(key, session);
  }
  return session;
}

export interface V2WebSocketServer {
  wss: WebSocketServer;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  broadcastRunUpdate: (status: RunStatus) => void;
  broadcastJobUpdate: (jobId: string) => void;
  broadcastReviewStateUpdate: (patientId: string, state: ReviewState, taskId?: string) => void;
}

export function attachWebSocketServer(server: HttpServer): V2WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // ── connection lifecycle ────────────────────────────────────────────
  wss.on("connection", (ws: WSClient, req: IncomingMessage) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");
    const reviewerId = resolveToken(token);
    if (authMode() === "required" && !reviewerId) {
      ws.close(4401, "unauthenticated");
      return;
    }
    ws.reviewer_id = reviewerId ?? "anonymous-reviewer";
    ws.isAlive = true;
    ws.send(JSON.stringify({
      type: "connected",
      message: "ready",
      reviewer_id: ws.reviewer_id,
    }));

    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (raw) => {
      let msg: IncomingWSMessage;
      try { msg = JSON.parse(raw.toString()) as IncomingWSMessage; }
      catch {
        ws.send(JSON.stringify({ type: "error", error: "invalid JSON" }));
        return;
      }
      try {
        switch (msg.type) {
          case "subscribe":
          case "chat": {
            if (typeof msg.patientId !== "string" || msg.patientId.length === 0) {
              ws.send(JSON.stringify({
                type: "error",
                error: `${msg.type} message requires a non-empty patientId`,
              }));
              return;
            }
            const taskId = msg.taskId ?? DEFAULT_TASK_ID;
            const session = getOrCreateSession(msg.patientId, taskId, msg.blindMode);
            (session as unknown as { subscribe: (ws: WSClient) => void }).subscribe(ws);
            if (msg.type === "subscribe") {
              ws.send(JSON.stringify({
                type: "history",
                patientId: msg.patientId,
                taskId,
                messages: chatStore.getMessages(msg.patientId),
              }));
            } else if (typeof msg.content === "string") {
              (session as unknown as { sendMessage: (s: string) => void }).sendMessage(msg.content);
            }
            break;
          }
          default:
            ws.send(JSON.stringify({ type: "error", error: "unknown message type" }));
        }
      } catch (e) {
        console.error("[ws] message handler threw:", (e as Error).message);
        try {
          ws.send(JSON.stringify({
            type: "error",
            error: `server error: ${(e as Error).message}`,
          }));
        } catch { /* socket already gone */ }
      }
    });

    ws.on("close", () => {
      for (const session of sessions.values()) {
        (session as unknown as { unsubscribe: (ws: WSClient) => void }).unsubscribe(ws);
      }
    });
  });

  // 30s heartbeat. Terminate any client that hasn't ponged since the last tick.
  const heartbeat = setInterval(() => {
    for (const c of wss.clients) {
      const ws = c as WSClient;
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already gone */ }
    }
  }, 30_000);
  wss.on("close", () => clearInterval(heartbeat));

  // ── upgrade handling ────────────────────────────────────────────────
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  };

  // ── broadcasters (consumed by REST handlers) ────────────────────────

  /** Run-status update — also fires the pilot auto-advance side-effect
   *  that v1's broadcastRunUpdate did, plus a maturity auto-advance
   *  (draft → piloted) when the run completes. */
  function broadcastRunUpdate(status: RunStatus): void {
    maybeAutoAdvancePilotOnRunStatus(status.run_id, status.state);
    maybeAutoAdvanceMaturityOnRunComplete(status);
    const payload = JSON.stringify({
      type: "agent_run_update",
      run_id: status.run_id,
      status,
    });
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      try { ws.send(payload); } catch { /* best-effort */ }
    }
  }

  function broadcastJobUpdate(jobId: string): void {
    const status = getJobStatus(jobId);
    const manifest = getJobManifest(jobId);
    if (!status || !manifest) return;
    const payload = JSON.stringify({
      type: "agent_job_update",
      job_id: jobId,
      status,
      manifest,
    });
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      try { ws.send(payload); } catch { /* best-effort */ }
    }
  }

  /** Push a review_state_update event to clients subscribed to the
   *  given (patient, task). Defaults taskId to DEFAULT_TASK_ID for v1
   *  callers that didn't thread it through; v2 routes pass it explicitly. */
  function broadcastReviewStateUpdate(
    patientId: string,
    state: ReviewState,
    taskId: string = DEFAULT_TASK_ID,
  ): void {
    const session = sessions.get(sessionKey(patientId, taskId, false));
    if (!session) return;
    const subscribers = (session as unknown as { subscribers: Set<WSClient> }).subscribers;
    if (!subscribers) return;
    const payload = JSON.stringify({
      type: "review_state_update",
      patientId,
      taskId,
      state,
    });
    for (const ws of subscribers) {
      if (ws.readyState !== ws.OPEN) continue;
      try { ws.send(payload); } catch { /* best-effort */ }
    }
  }

  return { wss, handleUpgrade, broadcastRunUpdate, broadcastJobUpdate, broadcastReviewStateUpdate };
}

// ── module-level broadcaster handles ───────────────────────────────────
// REST routes need to call broadcasters without taking an explicit
// dependency on the server-attach call. The server-attach function
// stores its broadcaster set here, and the helpers below forward.

let registry: Pick<V2WebSocketServer, "broadcastRunUpdate" | "broadcastJobUpdate" | "broadcastReviewStateUpdate"> | null = null;

export function registerBroadcasters(reg: V2WebSocketServer): void {
  registry = reg;
}

export function broadcastRunUpdate(status: RunStatus): void {
  if (registry) registry.broadcastRunUpdate(status);
  else {
    maybeAutoAdvancePilotOnRunStatus(status.run_id, status.state);
    maybeAutoAdvanceMaturityOnRunComplete(status);
  }
}
export function broadcastJobUpdate(jobId: string): void {
  if (registry) registry.broadcastJobUpdate(jobId);
}
export function broadcastReviewStateUpdate(patientId: string, state: ReviewState, taskId?: string): void {
  if (registry) registry.broadcastReviewStateUpdate(patientId, state, taskId);
}
