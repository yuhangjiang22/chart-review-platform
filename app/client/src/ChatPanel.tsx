import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "./types";
import { useFocusedField, focusedFieldPrefix } from "./focused-field";

export interface ChatPanelProps {
  patientId: string | null;
  connected: boolean;
  messages: ChatMessage[];
  busy: boolean;
  lastError?: string;
  send: (content: string) => void;
  /** "full" (default): render with header. "drawer": header is provided by the wrapper. */
  mode?: "full" | "drawer";
}

export function ChatPanel({
  patientId,
  connected,
  messages,
  busy,
  lastError,
  send,
  mode = "full",
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { focused } = useFocusedField();

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, busy]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || !patientId || busy) return;
    // #53 — prepend [focused_field: …, current_value: …] so the copilot can
    // resolve deictic questions ("what should I put here?") to the field the
    // reviewer is actually looking at. Invisible to the reviewer.
    send(focusedFieldPrefix(focused) + text);
    setDraft("");
  };

  return (
    <aside
      className={
        mode === "drawer"
          ? // Embedded in PatientDetail's chat rail — fill the parent so
            // the inner messages region has a bounded height to scroll inside.
            "w-full h-full bg-card flex flex-col min-h-0"
          : "w-[28rem] border-l border-border bg-card flex flex-col"
      }
    >
      <div className="shrink-0 px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <h2 className="font-semibold text-foreground text-sm uppercase tracking-wide">
          Agent
        </h2>
        {focused && (
          <span
            className="text-[11px] px-2 py-0.5 rounded bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))] border border-[hsl(var(--ochre)/0.25)] font-mono truncate max-w-[14rem]"
            title={`Chat is pinned to ${focused.fieldId}. Questions like "what should I put here?" resolve to this field.`}
          >
            📍 {focused.fieldId}
          </span>
        )}
        <span
          className={`text-[11px] px-2 py-0.5 rounded border ${
            connected
              ? "bg-[hsl(var(--sage)/0.12)] text-[hsl(var(--sage))] border-[hsl(var(--sage)/0.25)]"
              : "bg-muted text-muted-foreground border-border"
          }`}
        >
          {connected ? "connected" : "offline"}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && patientId && (
          <div className="text-xs text-muted-foreground/70">
            Ask the agent something about this patient. It can read notes,
            search across them, and record answers in the Review Form pane.
          </div>
        )}
        {!patientId && (
          <div className="text-xs text-muted-foreground/70">
            Select a patient to start chatting.
          </div>
        )}
        {messages.map((m, i) => (
          <Bubble
            key={m.id}
            msg={m}
            // #52 — narration heuristic: short assistant texts (≤ 200 chars)
            // immediately followed by a tool_use are "I'll do X" narration.
            // Render them as compact, italic, low-emphasis lines instead of
            // a full speech bubble.
            isNarration={
              m.role === "assistant" &&
              (m.content ?? "").length <= 200 &&
              messages[i + 1]?.role === "tool"
            }
          />
        ))}
        {busy && (
          <div className="text-xs text-muted-foreground/70 italic">agent thinking…</div>
        )}
        {lastError && (
          <div className="text-xs text-[hsl(var(--oxblood))]">error: {lastError}</div>
        )}
      </div>

      <form
        onSubmit={submit}
        className="shrink-0 border-t border-border p-2 flex gap-2"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit(e);
          }}
          placeholder={
            patientId
              ? "Ask about this patient (Enter to send, Shift+Enter for newline)"
              : "Select a patient first"
          }
          disabled={!patientId || busy}
          rows={2}
          className="flex-1 resize-none rounded border border-border px-2 py-1 text-sm focus:outline-none focus:border-border"
        />
        <button
          type="submit"
          disabled={!patientId || busy || draft.trim().length === 0}
          className="px-3 py-1 rounded bg-primary text-white text-sm disabled:bg-secondary"
        >
          Send
        </button>
      </form>
    </aside>
  );
}

// #51 — friendly status pill per tool call, instead of the raw
// `Read({"file_path":"..."})` content the agent would otherwise dump.
function describeToolCall(toolName: string, input: unknown): { icon: string; verb: string; detail: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const baseName = (p: unknown): string => {
    const s = typeof p === "string" ? p : "";
    return s.split("/").pop() ?? s;
  };
  switch (toolName) {
    case "Skill":
      return { icon: "✨", verb: "activating skill", detail: String(i.skill ?? "") };
    case "Read":
      return { icon: "📖", verb: "reading", detail: baseName(i.file_path) };
    case "Glob":
      return { icon: "🔍", verb: "globbing", detail: String(i.pattern ?? "") };
    case "Grep":
      return { icon: "🔎", verb: "grepping", detail: String(i.pattern ?? "") };
    case "Bash":
      return { icon: "⚡", verb: "running shell", detail: String(i.description ?? "...") };
    case "Write":
      return { icon: "✏️", verb: "writing", detail: baseName(i.file_path) };
    case "Edit":
      return { icon: "✏️", verb: "editing", detail: baseName(i.file_path) };
    default:
      if (toolName.startsWith("mcp__")) {
        const action = toolName.replace(/^mcp__[^_]+__/, "");
        return { icon: "💾", verb: "MCP", detail: action };
      }
      return { icon: "🛠", verb: toolName, detail: "" };
  }
}

function Bubble({ msg, isNarration }: { msg: ChatMessage; isNarration?: boolean }) {
  if (msg.role === "tool") {
    const { icon, verb, detail } = describeToolCall(
      msg.tool_name ?? "",
      msg.tool_input,
    );
    return (
      <div className="text-[11px] text-muted-foreground px-2 py-0.5 inline-flex items-center gap-1">
        <span aria-hidden>{icon}</span>
        <span className="text-muted-foreground">{verb}</span>
        {detail && (
          <code className="font-mono text-foreground truncate max-w-[20rem]">
            {detail}
          </code>
        )}
      </div>
    );
  }
  // #52 — compact, italic, low-emphasis treatment for narration sentences
  // ("I'll do X", "Let me check Y") that precede tool calls. The agent's
  // substantive answer (the long assistant text after all tool calls) keeps
  // the prominent bubble.
  if (isNarration) {
    return (
      <div className="text-[11px] text-muted-foreground/70 italic px-2 py-0.5 truncate">
        💭 {msg.content}
      </div>
    );
  }
  const isUser = msg.role === "user";
  return (
    <div className={`flex flex-col ${isUser ? "items-end pl-8" : "items-start pr-8"}`}>
      <span
        className="mb-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60"
        aria-label={isUser ? "you" : "agent"}
        data-role={isUser ? "you" : "agent"}
      >
        {isUser ? "you ·" : "agent ·"}
      </span>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
          isUser ? "bg-primary text-white" : "bg-muted text-foreground"
        }`}
      >
        {msg.content}
      </div>
    </div>
  );
}
