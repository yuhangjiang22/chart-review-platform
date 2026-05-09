import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ReviewState, ServerEvent } from "./types";
import { authFetch, buildWsUrl } from "./auth";

export interface AgentSocketState {
  connected: boolean;
  messages: ChatMessage[];
  busy: boolean;
  lastError?: string;
  reviewState: ReviewState | null;
  send: (content: string) => void;
  refreshReviewState: (state: ReviewState) => void;
}

/**
 * Subscribe to a single patient's chat session over WebSocket.
 * Re-subscribing on patientId change clears local state.
 */
export function useAgentSocket(
  patientId: string | null,
  taskId: string | null,
): AgentSocketState {
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>();
  const [reviewState, setReviewState] = useState<ReviewState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // On patient change, fetch the latest persisted review state up-front so
  // the Review Form pane is populated even if no chat events have fired yet.
  useEffect(() => {
    if (!patientId || !taskId) {
      setReviewState(null);
      return;
    }
    authFetch(`/api/reviews/${patientId}/${taskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setReviewState(s));
  }, [patientId, taskId]);

  useEffect(() => {
    if (!patientId) return;
    setMessages([]);
    setBusy(false);
    setLastError(undefined);

    const url = buildWsUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "subscribe", patientId, taskId }));
    };
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setLastError("websocket error");

    ws.onmessage = (ev) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (event.type) {
        case "history":
          setMessages(event.messages);
          break;
        case "user_message":
          setBusy(true);
          setMessages((m) => [...m, mkMessage("user", event.content)]);
          break;
        case "assistant_message":
          setMessages((m) => [...m, mkMessage("assistant", event.content)]);
          break;
        case "tool_use":
          setMessages((m) => [
            ...m,
            mkToolMessage(event.toolName, event.toolInput),
          ]);
          break;
        case "result":
          setBusy(false);
          if (!event.success) setLastError("agent run failed");
          break;
        case "review_state_update":
          setReviewState(event.state);
          break;
        case "error":
          setBusy(false);
          setLastError(event.error);
          break;
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, taskId]);

  const send = useCallback(
    (content: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !patientId) return;
      setBusy(true);
      ws.send(JSON.stringify({ type: "chat", patientId, taskId, content }));
    },
    [patientId, taskId],
  );

  return {
    connected,
    messages,
    busy,
    lastError,
    reviewState,
    send,
    refreshReviewState: setReviewState,
  };
}

function mkMessage(role: "user" | "assistant", content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: new Date().toISOString(),
  };
}

function mkToolMessage(toolName: string, toolInput: unknown): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "tool",
    content: `${toolName}(${JSON.stringify(toolInput ?? {})})`,
    tool_name: toolName,
    tool_input: toolInput,
    timestamp: new Date().toISOString(),
  };
}
