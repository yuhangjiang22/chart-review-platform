import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../../auth";

/** Live agent-log panel: polls the per-patient audit ndjson while the
 *  iter is running, renders one row per event (timestamp + step_type
 *  + summary). Auto-scrolls. Stops polling when the iter terminates
 *  (parent passes `live=false`). */

interface AuditEntry {
  ts: string;
  step_type: string;
  tool_name?: string;
  tool_input?: unknown;
  result_preview?: string;
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

function summarize(entry: AuditEntry): string {
  switch (entry.step_type) {
    case "session_start":
      return `session start (${entry.model ?? "?"})`;
    case "user_message":
      return entry.text ? `→ user: ${entry.text.slice(0, 160)}` : "→ user";
    case "assistant_text":
      return entry.text ? `← assistant: ${entry.text.slice(0, 160)}` : "← assistant";
    case "tool_call_pre": {
      const inp = entry.tool_input
        ? JSON.stringify(entry.tool_input).slice(0, 100)
        : "";
      return `tool ${entry.tool_name ?? "?"}(${inp}${inp.length >= 100 ? "…" : ""})`;
    }
    case "tool_call_post":
      return `← ${entry.tool_name ?? "?"} ${(entry.result_preview ?? "").slice(0, 120)}`;
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
      if (live) timer = setTimeout(tick, 2000);
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
          {patientIds.length > 1 && (
            <div className="flex gap-1 overflow-x-auto px-3 py-2 text-[11px]">
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

          <div
            ref={scrollRef}
            className="h-72 overflow-y-auto bg-background px-3 py-2 font-mono text-[11px] leading-relaxed"
          >
            {entries.length === 0 ? (
              <div className="text-muted-foreground italic">
                {live ? "Waiting for agent activity…" : "No log entries."}
              </div>
            ) : (
              entries.map((e, i) => (
                <div key={i} className={colorForStep(e.step_type)}>
                  <span className="text-muted-foreground mr-2">{shortTs(e.ts)}</span>
                  {summarize(e)}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
