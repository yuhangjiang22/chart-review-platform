// app/client/src/ui/builder/useBuilderSocket.ts
import { useEffect, useRef, useState, useCallback } from "react";
import type { BuilderEvent, BuilderState, PhaseMarkers } from "./types";

export interface BuilderSocketMessage {
  id: string;
  kind: "user" | "assistant_prose" | "citation_pill" | "error";
  content: string;
  citationPath?: string;
  citationSource?: "sample" | "reference";
  ts: string;
}

export interface UseBuilderSocket {
  connected: boolean;
  busy: boolean;
  messages: BuilderSocketMessage[];
  state: BuilderState | null;
  phaseMarkers: PhaseMarkers;
  sendUserMessage: (content: string) => void;
  lastError: string | null;
  currentTool: { name: string; input: unknown } | null;
}

export interface UseBuilderSocketOptions {
  /** Called once each time the agent finishes a turn (busy → not busy).
   *  The Builder uses this to notify the Library to refresh the task list
   *  (B3 fix). Fires at most once per agent turn, never on initial mount. */
  onAgentIdle?: () => void;
}

export function useBuilderSocket(
  taskId: string | null,
  token: string | null,
  options?: UseBuilderSocketOptions,
): UseBuilderSocket {
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<BuilderSocketMessage[]>([]);
  const [state, setState] = useState<BuilderState | null>(null);
  const [phaseMarkers, setPhaseMarkers] = useState<PhaseMarkers>({});
  const [lastError, setLastError] = useState<string | null>(null);
  const [currentTool, setCurrentTool] = useState<{ name: string; input: unknown } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Stable ref so the WebSocket handler always sees the latest callback
  // without re-opening the socket when the callback identity changes.
  const onAgentIdleRef = useRef(options?.onAgentIdle);
  useEffect(() => {
    onAgentIdleRef.current = options?.onAgentIdle;
  });

  useEffect(() => {
    if (!taskId || !token) return;
    const url = `ws://${window.location.hostname}:3001/api/builder/sessions/${encodeURIComponent(
      taskId,
    )}/stream?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setLastError("websocket error");

    ws.onmessage = (e) => {
      let ev: BuilderEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      handleEvent(ev);
    };

    function handleEvent(ev: BuilderEvent) {
      switch (ev.type) {
        case "state":
          setState(ev.state);
          // Hydrate phaseMarkers from the initial state snapshot
          if (ev.state.phase_markers) setPhaseMarkers(ev.state.phase_markers);
          break;
        case "phase_change":
          setState((s) => s ? { ...s, phase: ev.phase } : s);
          break;
        case "phase_status":
          setPhaseMarkers((m) => ({ ...m, [ev.phase_name]: ev.status }));
          // Also mirror into state so the two sources stay in sync
          setState((s) =>
            s
              ? { ...s, phase_markers: { ...(s.phase_markers ?? {}), [ev.phase_name]: ev.status } }
              : s
          );
          break;
        case "citation_pill":
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              kind: "citation_pill",
              content: ev.path,
              citationPath: ev.path,
              citationSource: ev.source,
              ts: new Date().toISOString(),
            },
          ]);
          break;
        case "assistant_prose":
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              kind: "assistant_prose",
              content: ev.text,
              ts: new Date().toISOString(),
            },
          ]);
          break;
        case "tool_use":
          // Update live status; do NOT append to messages.
          setCurrentTool({ name: ev.tool, input: ev.input });
          break;
        case "agent_busy":
          setBusy(ev.busy);
          if (!ev.busy) {
            setCurrentTool(null);
            // B3: notify the Library to refresh the task list once per
            // completion (busy → idle). We check that the session has at
            // least one message so we don't fire on the initial state sync.
            onAgentIdleRef.current?.();
          }
          break;
        case "history":
          setMessages(
            ev.messages.map((m) => ({
              id: crypto.randomUUID(),
              kind: m.kind,
              content: m.content,
              ts: m.ts,
            })),
          );
          break;
        case "error":
          setLastError(ev.message);
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              kind: "error",
              content: ev.message,
              ts: new Date().toISOString(),
            },
          ]);
          break;
      }
    }

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [taskId, token]);

  const sendUserMessage = useCallback((content: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "user_message", content }));
    setMessages((m) => [
      ...m,
      {
        id: crypto.randomUUID(),
        kind: "user",
        content,
        ts: new Date().toISOString(),
      },
    ]);
  }, []);

  return { connected, busy, messages, state, phaseMarkers, sendUserMessage, lastError, currentTool };
}
