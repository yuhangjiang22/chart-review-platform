import { useEffect, useState } from "react";
import { ChatPanel, type ChatPanelProps } from "./ChatPanel";

export function ChatDrawer(
  props: Omit<ChatPanelProps, "patientId" | "mode"> & { patientId: string | null },
) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    function onToggle() {
      setExpanded((v) => !v);
    }
    window.addEventListener("chartreview:toggleChat", onToggle);
    return () => window.removeEventListener("chartreview:toggleChat", onToggle);
  }, []);

  if (!expanded) {
    const latest = [...props.messages].reverse().find((m) => m.role === "tool");
    return (
      <button
        onClick={() => setExpanded(true)}
        className="border-t border-border bg-muted/50 px-4 py-1.5 text-[11.5px] text-muted-foreground text-left hover:bg-muted inline-flex items-center gap-2 w-full"
        title="Press c to toggle chat"
      >
        <span className={props.connected ? "text-emerald-500" : "text-muted-foreground/70"}>
          ●
        </span>
        <span className="truncate flex-1">
          {latest
            ? latest.content
            : props.busy
              ? "agent thinking…"
              : "click to open chat (c)"}
        </span>
      </button>
    );
  }

  return (
    <div className="border-t border-border bg-card" style={{ height: "30vh" }}>
      <div className="flex items-center justify-between px-3 py-1 border-b border-border/50 text-[11.5px]">
        <span className="text-muted-foreground">Chat with agent</span>
        <button
          onClick={() => setExpanded(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          collapse
        </button>
      </div>
      <ChatPanel {...props} mode="full" />
    </div>
  );
}
