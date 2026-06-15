import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BuilderSocketMessage } from "./useBuilderSocket";

function friendlyToolLabel(currentTool: { name: string; input: unknown } | null): string {
  if (!currentTool) return "Thinking…";
  const { name, input } = currentTool;
  const tool = name.includes("__") ? name.split("__").pop() ?? name : name;

  if (tool === "mark_drafted") return "Drafting guideline…";
  if (tool === "Write") {
    const fp = (input as any)?.file_path ?? (input as any)?.path;
    if (typeof fp === "string") {
      const short = fp.split("/").slice(-2).join("/");
      return `Writing ${short}…`;
    }
    return "Writing file…";
  }
  if (tool === "Read" || tool === "mcp__filesystem__read_file") {
    const fp = (input as any)?.file_path ?? (input as any)?.path;
    if (typeof fp === "string") {
      const short = fp.split("/").slice(-2).join("/");
      return `Reading ${short}…`;
    }
    return "Reading…";
  }
  if (tool === "Grep") {
    const pattern = (input as any)?.pattern;
    return pattern ? `Searching "${String(pattern).slice(0, 40)}"…` : "Searching…";
  }
  if (tool === "Glob") return "Listing files…";
  if (tool === "WebFetch") return "Fetching URL…";
  if (tool === "Skill") {
    const skillName = (input as any)?.skill;
    return skillName ? `Activating skill: ${skillName}…` : "Activating skill…";
  }
  return `${tool}…`;
}

interface Props {
  taskId: string;
  token: string;
  messages: BuilderSocketMessage[];
  busy: boolean;
  connected: boolean;
  currentTool: { name: string; input: unknown } | null;
  onSendUserMessage: (content: string) => void;
  onCitationClick: (source: "sample" | "reference", path: string) => void;
}

export function BuilderChatRail({
  taskId,
  token,
  messages,
  busy,
  connected,
  currentTool,
  onSendUserMessage,
  onCitationClick,
}: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, busy]);

  const handleAttach = async (file: File) => {
    if (busy) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/builder/sessions/${taskId}/references`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (!res.ok) {
      console.error("upload failed", await res.text());
    }
  };

  return (
    <aside className="flex h-full flex-col min-h-0 border-r border-border bg-paper/50">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="font-serif text-sm uppercase tracking-wide">Builder</span>
        <span className={connected ? "text-sage" : "text-ochre"}>
          {connected ? "•" : "○"}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {messages.map((m) => {
          if (m.kind === "citation_pill" && m.citationPath) {
            return (
              <button
                key={m.id}
                onClick={() => onCitationClick(m.citationSource ?? "sample", m.citationPath!)}
                className="block w-full rounded bg-sage/10 px-2 py-1 text-left text-xs underline"
              >
                📎 {m.citationPath}
              </button>
            );
          }
          if (m.kind === "user") {
            return (
              <div key={m.id} className="rounded bg-card p-2 text-sm self-end">
                {m.content}
              </div>
            );
          }
          if (m.kind === "error") {
            return (
              <div key={m.id} className="rounded bg-ochre/10 border border-ochre/30 p-2 text-xs text-ochre">
                {m.content}
              </div>
            );
          }
          // assistant_prose — plain markdown render
          return (
            <div key={m.id} className="rounded bg-paper p-2 text-sm [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:font-serif [&_h1]:text-base [&_h1]:my-2 [&_h2]:font-serif [&_h2]:text-sm [&_h2]:my-2 [&_h3]:font-serif [&_h3]:text-sm [&_h3]:my-1 [&_pre]:bg-card [&_pre]:rounded [&_pre]:p-2 [&_pre]:text-foreground [&_pre]:my-1 [&_code]:text-foreground [&_code]:font-mono [&_code]:text-[11px] [&_a]:text-oxblood [&_a]:underline">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
            </div>
          );
        })}
      </div>

      {busy && (
        <div className="shrink-0 border-t border-border px-3 py-1.5 bg-paper/60">
          <div className="flex items-center gap-2 text-xs">
            <span className="relative inline-flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-oxblood opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-oxblood"></span>
            </span>
            <span className="text-muted-foreground italic truncate">
              {friendlyToolLabel(currentTool)}
            </span>
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim().length === 0 || busy) return;
          onSendUserMessage(draft.trim());
          setDraft("");
        }}
        onDrop={async (e) => {
          e.preventDefault();
          if (busy) return;
          const file = e.dataTransfer.files?.[0];
          if (file) await handleAttach(file);
        }}
        onDragOver={(e) => e.preventDefault()}
        className="shrink-0 border-t border-border p-2 flex gap-2"
      >
        <label className={`self-center ${busy ? "opacity-50 cursor-not-allowed" : "cursor-pointer text-muted-foreground"}`}>
          📎
          <input
            type="file"
            className="hidden"
            disabled={busy}
            onChange={async (e) => {
              if (busy) return;
              const f = e.target.files?.[0];
              if (f) await handleAttach(f);
            }}
          />
        </label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (draft.trim().length > 0 && !busy) {
                onSendUserMessage(draft.trim());
                setDraft("");
              }
            }
          }}
          rows={2}
          disabled={!connected || busy}
          placeholder="Type a reply or drop a file…"
          className="flex-1 resize-none rounded border border-border px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={!connected || busy || draft.trim().length === 0}
          className="shrink-0 rounded bg-oxblood px-3 py-1 text-paper text-xs disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </aside>
  );
}
