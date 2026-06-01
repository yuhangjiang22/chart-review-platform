import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../../auth";

/** Live agent-log panel: polls the per-patient audit ndjson while the
 *  iter is running, renders one row per event (timestamp + step_type
 *  + summary). Auto-scrolls. Stops polling when the iter terminates
 *  (parent passes `live=false`). */

interface AuditEntry {
  ts: string;
  step_type: string;
  /** Set when the row came from a per-agent transcript file
   *  (multi-agent runs include this so the UI can attribute calls). */
  agent_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  result_preview?: string;
  result_truncated?: boolean;
  text?: string;
  payload_summary?: string;
  action_type?: string;
  source?: string;
  message?: string;
  field_id?: string;
  target?: string;
  cost_usd?: number;
  duration_ms?: number;
  success?: boolean;
  model?: string;
}

interface AgentLogPanelProps {
  runId: string;
  patientIds: string[];
  /** True while the run is in flight. Polling stops when this flips false. */
  live: boolean;
}

function shortTs(ts: string): string {
  // 2026-05-11T19:30:00.123Z → 19:30:00
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : ts;
}

/** Strip the noisy `mcp__chart_review_state__` / `mcp__chart_review_ner__`
 *  / `mcp__chart_review_adherence__` prefix so the UI shows just the
 *  tool name. */
function shortenToolName(name: string | undefined): string {
  if (!name) return "?";
  return name
    .replace(/^mcp__chart_review_(state|ner|adherence)__/, "")
    .replace(/^mcp__/, "");
}

/** Pull the most-informative single argument from tool_input so the row
 *  shows what the call is about without dumping every key. */
function pickArgPreview(toolName: string | undefined, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  // Common short-key candidates, in order of preference per tool.
  const candidates = [
    "field_id", "question_id", "rule_id", "filename", "filenames",
    "note_id", "table", "entity_type", "label", "command", "snippet",
  ];
  for (const k of candidates) {
    const v = o[k];
    if (v == null) continue;
    if (Array.isArray(v)) {
      const peek = v.slice(0, 3).map(String).join(",");
      return `${k}=[${peek}${v.length > 3 ? ",…" : ""}]`;
    }
    const s = String(v);
    return `${k}=${s.length > 60 ? s.slice(0, 60) + "…" : s}`;
  }
  // Fall back to the first scalar key.
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const s = String(v);
      return `${k}=${s.length > 60 ? s.slice(0, 60) + "…" : s}`;
    }
  }
  void toolName;
  return "";
}

function summarize(entry: AuditEntry): string {
  switch (entry.step_type) {
    case "session_start":
      return `session start (${entry.model ?? "?"})`;
    case "user_message":
      return entry.text ? `→ user: ${entry.text.slice(0, 160)}` : "→ user";
    case "assistant_text": {
      // Strip markdown emphasis from the one-line preview so "**Following
      // tool steps**" reads as "Following tool steps".
      const t = (entry.text ?? "").replace(/^\*+|\*+$/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ");
      return t ? `💭 ${t.slice(0, 200)}${t.length > 200 ? "…" : ""}` : "💭 (empty)";
    }
    case "tool_call_pre": {
      const name = shortenToolName(entry.tool_name);
      const args = pickArgPreview(entry.tool_name, entry.tool_input);
      return `→ ${name}${args ? `  ${args}` : ""}`;
    }
    case "tool_call_post": {
      const name = shortenToolName(entry.tool_name);
      const preview = (entry.result_preview ?? "").slice(0, 120).replace(/\s+/g, " ");
      return `← ${name}  ${preview}`;
    }
    case "ui_action":
      return `ui_action ${entry.action_type ?? "?"} ${entry.payload_summary ?? ""}`;
    case "state_write":
      return `state_write ${entry.target ?? ""}`;
    case "result":
      return `result ok=${entry.success} cost=$${(entry.cost_usd ?? 0).toFixed(4)} ${(entry.duration_ms ?? 0)}ms`;
    case "error":
      return `error: ${entry.message ?? "(no message)"}`;
    case "accept_agent_draft":
      return `accept_agent_draft ${entry.field_id ?? ""}`;
    default:
      return entry.step_type;
  }
}

/** Decide whether a row has any expandable detail worth showing. */
function isExpandable(e: AuditEntry): boolean {
  switch (e.step_type) {
    case "tool_call_pre":  return !!e.tool_input;
    case "tool_call_post": return !!e.result_preview;
    case "assistant_text":
    case "user_message":   return !!(e.text && e.text.length > 0);
    case "error":          return !!e.message;
    default:               return false;
  }
}

/** Peel the MCP content-block wrapper. Tool responses arrive as
 *  `{ content: [{ type: "text", text: "<json string>" }], structured_content }`
 *  — the actual tool output is the string inside `content[0].text`. Walk
 *  that wrapper, parse the inner text again when it's JSON, and return
 *  the cleanest form for display. */
function unwrapToolResponse(parsed: unknown): { unwrapped: unknown; layers: string[] } {
  const layers: string[] = [];
  let cur: unknown = parsed;
  // MCP envelope
  if (
    cur && typeof cur === "object" && !Array.isArray(cur)
    && Array.isArray((cur as { content?: unknown }).content)
  ) {
    const content = (cur as { content: Array<{ type?: string; text?: string }> }).content;
    const textBlocks = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (textBlocks.length > 0) {
      layers.push("MCP content envelope");
      const joined = textBlocks.join("\n");
      try {
        cur = JSON.parse(joined);
        layers.push("inner JSON string");
      } catch {
        cur = joined;
      }
    }
  }
  return { unwrapped: cur, layers };
}

/** Pretty-print the detail body for the expanded view. */
function expandedBody(e: AuditEntry): string {
  switch (e.step_type) {
    case "tool_call_pre":
      try { return JSON.stringify(e.tool_input, null, 2); }
      catch { return String(e.tool_input ?? ""); }
    case "tool_call_post": {
      const raw = e.result_preview ?? "";
      let pretty = raw;
      let header = "";
      try {
        const parsed = JSON.parse(raw);
        const { unwrapped, layers } = unwrapToolResponse(parsed);
        pretty = typeof unwrapped === "string"
          ? unwrapped
          : JSON.stringify(unwrapped, null, 2);
        if (layers.length > 0) header = `// peeled: ${layers.join(" → ")}\n`;
      } catch {
        // Not JSON — show raw.
      }
      const trunc = e.result_truncated ? "\n\n…[truncated server-side at 2KB]" : "";
      return `${header}${pretty}${trunc}`;
    }
    case "assistant_text": return e.text ?? "";
    case "user_message":   return e.text ?? "";
    case "error":          return e.message ?? "";
    default:               return "";
  }
}

function colorForStep(step: string): string {
  switch (step) {
    case "tool_call_pre": return "text-[hsl(var(--oxblood))]";
    case "tool_call_post": return "text-emerald-700";
    case "error": return "text-red-700 font-semibold";
    case "result": return "text-amber-700";
    case "assistant_text": return "text-foreground";
    case "user_message": return "text-muted-foreground";
    case "state_write": return "text-blue-700";
    default: return "text-muted-foreground";
  }
}

export function AgentLogPanel({ runId, patientIds, live }: AgentLogPanelProps) {
  const [entriesByPid, setEntriesByPid] = useState<Record<string, AuditEntry[]>>({});
  const [activePid, setActivePid] = useState<string>(patientIds[0] ?? "");
  const [open, setOpen] = useState<boolean>(true);
  /** Row indices currently expanded — keyed by `${pid}:${idx}` so toggles
   *  on one patient don't bleed into others as activePid switches. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandAll, setExpandAll] = useState<boolean>(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep activePid valid as patient set changes.
  useEffect(() => {
    if (!activePid && patientIds[0]) setActivePid(patientIds[0]);
    if (activePid && !patientIds.includes(activePid) && patientIds[0]) {
      setActivePid(patientIds[0]);
    }
  }, [patientIds, activePid]);

  const fetchAuditForPid = useCallback(
    async (pid: string): Promise<AuditEntry[]> => {
      const r = await authFetch(
        `/api/runs/${encodeURIComponent(runId)}/patients/${encodeURIComponent(pid)}/audit`,
      );
      if (!r.ok) return [];
      const text = await r.text();
      return text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try { return JSON.parse(l) as AuditEntry; }
          catch { return null; }
        })
        .filter((e): e is AuditEntry => e !== null);
    },
    [runId],
  );

  // Poll loop while live; one-shot fetch on mount when not live.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const next: Record<string, AuditEntry[]> = {};
      for (const pid of patientIds) {
        next[pid] = await fetchAuditForPid(pid);
      }
      if (cancelled) return;
      setEntriesByPid(next);
      // 1s while running — fast enough that tool calls land within a
      // single human attention span. The audit endpoint is cheap (file
      // reads + JSON round-trip), so 1Hz polling is acceptable.
      if (live) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, patientIds, live, fetchAuditForPid]);

  // Auto-scroll to bottom on new entries.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entriesByPid, activePid, open]);

  const entries = activePid ? entriesByPid[activePid] ?? [] : [];

  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Agent log
          </span>
          {live && (
            <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-[hsl(var(--oxblood))]" />
          )}
          <span className="font-mono text-[11px] text-muted-foreground">
            {entries.length} events
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {open ? "hide" : "show"}
        </span>
      </button>

      {open && (
        <div className="border-t border-border">
          <div className="flex items-center gap-2 px-3 py-2 text-[11px]">
            {patientIds.length > 1 && (
              <div className="flex gap-1 overflow-x-auto flex-1">
                {patientIds.map((pid) => (
                  <button
                    type="button"
                    key={pid}
                    onClick={() => setActivePid(pid)}
                    className={
                      "rounded px-2 py-1 font-mono whitespace-nowrap " +
                      (pid === activePid
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground hover:text-foreground")
                    }
                  >
                    {pid} <span className="opacity-60">({entriesByPid[pid]?.length ?? 0})</span>
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setExpandAll((v) => !v)}
              className="ml-auto rounded px-2 py-1 text-[10.5px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              title="Show/hide full payload on every row"
            >
              {expandAll ? "Collapse all" : "Expand all"}
            </button>
            {activePid && (
              <a
                href={`/api/runs/${encodeURIComponent(runId)}/patients/${encodeURIComponent(activePid)}/audit`}
                target="_blank"
                rel="noreferrer"
                className="rounded px-2 py-1 text-[10.5px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                title="Download raw NDJSON for this patient"
              >
                Raw .jsonl
              </a>
            )}
          </div>

          <div
            ref={scrollRef}
            className="h-72 overflow-y-auto bg-background px-3 py-2 font-mono text-[11px] leading-relaxed"
          >
            {entries.length === 0 ? (
              <div className="text-muted-foreground italic">
                {live ? "Waiting for agent activity…" : "No log entries."}
              </div>
            ) : (
              entries.map((e, i) => {
                const key = `${activePid}:${i}`;
                const expandable = isExpandable(e);
                const isOpen = expandable && (expandAll || expanded.has(key));
                return (
                  <div key={i}>
                    <div
                      className={
                        colorForStep(e.step_type)
                        + (expandable ? " cursor-pointer hover:bg-muted/30" : "")
                      }
                      onClick={() => {
                        if (!expandable) return;
                        setExpanded((s) => {
                          const next = new Set(s);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        });
                      }}
                    >
                      {expandable && (
                        <span className="text-muted-foreground/60 mr-1 select-none">
                          {isOpen ? "▾" : "▸"}
                        </span>
                      )}
                      <span className="text-muted-foreground mr-2">{shortTs(e.ts)}</span>
                      {e.agent_id && (
                        <span className="text-muted-foreground mr-2 opacity-70">
                          [{e.agent_id.replace(/^agent_/, "A")}]
                        </span>
                      )}
                      {summarize(e)}
                    </div>
                    {isOpen && (
                      <pre className="whitespace-pre-wrap break-words border-l border-border/60 bg-muted/30 ml-3 mt-0.5 mb-1 px-2 py-1.5 text-[10.5px] leading-snug text-foreground/80">
                        {expandedBody(e)}
                      </pre>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
