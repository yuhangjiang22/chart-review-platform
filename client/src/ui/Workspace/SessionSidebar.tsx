// SessionSidebar — right-side collapsible context panel for the active
// session. Shows:
//   - Session header (name + state + skill snapshot SHA)
//   - Cohort (patient IDs with per-patient validation status)
//   - Agents (locked config from session.agent_specs)
//   - Iters (chronological list with state badges, click to focus)
//   - Skill snapshot pointer (link back to AUTHOR for editing)
//
// Collapses to a thin (32px) right gutter via a toggle. Open state
// persisted to localStorage keyed by taskId.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronLeft, FileText } from "lucide-react";
import { authFetch } from "../../auth";

interface AgentSpecLite {
  id: string;
  search_mode_preset?: string;
  interpretation_preset?: string;
  model?: string;
}

interface SessionShape {
  session_id: string;
  name: string;
  state: "active" | "archived";
  started_at: string;
  cohort: { patient_ids: string[] };
  agent_specs?: AgentSpecLite[];
  default_agent_specs?: AgentSpecLite[];
  skill_snapshot_sha: string;
}

interface IterShape {
  iter_id: string;
  iter_num: number;
  state: string;
  started_at: string;
  guideline_sha?: string;
}

interface SessionSidebarProps {
  taskId: string;
  activeSessionId: string | null;
  /** Iters that belong to the active session (filtered upstream). */
  sessionIters: IterShape[];
  /** Per-patient validation status (oracle_done flag). Drives the
   *  cohort row badges. Keyed by patient_id. */
  patientStatus: Record<string, { oracle_done: boolean; errored?: boolean }>;
  isOpen: boolean;
  onToggle: () => void;
  /** Navigate to AUTHOR phase (skill snapshot link). */
  onJumpToAuthor: () => void;
}

function fmtDate(iso: string): string {
  if (!iso || iso.startsWith("1970")) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function SessionSidebar({
  taskId, activeSessionId, sessionIters, patientStatus, isOpen, onToggle, onJumpToAuthor,
}: SessionSidebarProps) {
  const [session, setSession] = useState<SessionShape | null>(null);

  useEffect(() => {
    if (!activeSessionId) { setSession(null); return; }
    let cancelled = false;
    authFetch(`/api/sessions/${encodeURIComponent(taskId)}/${encodeURIComponent(activeSessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.session) setSession(d.session); })
      .catch(() => { /* swallow */ });
    return () => { cancelled = true; };
  }, [taskId, activeSessionId]);

  // Collapsed: thin right rail with a chevron to expand.
  if (!isOpen) {
    return (
      <aside className="w-8 shrink-0 sticky top-0 self-start h-screen flex flex-col items-center border-l border-border bg-paper/30">
        <button
          type="button"
          onClick={onToggle}
          className="mt-4 p-1.5 rounded hover:bg-paper/80 text-muted-foreground hover:text-ink"
          aria-label="Expand session sidebar"
          title="Expand session sidebar"
        >
          <ChevronLeft size={14} strokeWidth={1.75} />
        </button>
      </aside>
    );
  }

  const specs = session?.agent_specs ?? session?.default_agent_specs ?? [];

  return (
    <aside
      className={cn(
        "w-[300px] shrink-0 sticky top-0 self-start max-h-screen overflow-y-auto",
        "border-l border-border bg-paper/30",
      )}
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-2 border-b border-border/60">
        <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Session
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="p-1 rounded hover:bg-paper/80 text-muted-foreground hover:text-ink"
          aria-label="Collapse session sidebar"
          title="Collapse"
        >
          <ChevronRight size={14} strokeWidth={1.75} />
        </button>
      </div>

      {!activeSessionId || !session ? (
        <div className="px-3 py-6 text-[12px] text-muted-foreground italic text-center">
          {!activeSessionId ? "No active session." : "Loading session…"}
        </div>
      ) : (
        <div className="px-3 py-3 space-y-5 text-[11.5px]">
          {/* Header */}
          <div>
            <div className="font-medium text-[13px] text-ink truncate">{session.name}</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span
                className={cn(
                  "rounded px-1.5 py-[1px] text-[9.5px] uppercase tracking-[0.12em]",
                  session.state === "active"
                    ? "bg-[hsl(var(--sage))]/15 text-[hsl(var(--sage))]"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {session.state}
              </span>
              <span className="text-[10px] text-muted-foreground">{fmtDate(session.started_at)}</span>
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground font-mono truncate">
              snapshot {session.skill_snapshot_sha.slice(0, 12) || "—"}
            </div>
          </div>

          {/* Cohort */}
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground mb-1">
              Cohort ({session.cohort.patient_ids.length})
            </div>
            <div className="space-y-0.5 max-h-[180px] overflow-y-auto">
              {session.cohort.patient_ids.map((pid) => {
                const st = patientStatus[pid];
                const tone = st?.errored
                  ? "text-[hsl(var(--oxblood))]"
                  : st?.oracle_done
                    ? "text-[hsl(var(--sage))]"
                    : "text-muted-foreground";
                const dot = st?.errored
                  ? "bg-[hsl(var(--oxblood))]"
                  : st?.oracle_done
                    ? "bg-[hsl(var(--sage))]"
                    : "bg-muted-foreground/30";
                return (
                  <div key={pid} className="flex items-center gap-1.5">
                    <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", dot)} />
                    <span className={cn("font-mono text-[11px] truncate", tone)}>{pid}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Agents */}
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground mb-1">
              Agents ({specs.length})
            </div>
            {specs.length === 0 ? (
              <div className="text-[10.5px] text-muted-foreground italic">No agent_specs locked.</div>
            ) : (
              <div className="space-y-0.5 text-[11px] font-mono">
                {specs.map((s) => {
                  const parts = [s.search_mode_preset, s.interpretation_preset, s.model || "(env default)"]
                    .filter(Boolean);
                  return (
                    <div key={s.id} className="truncate">
                      <span className="text-muted-foreground">{s.id}:</span> {parts.join(" · ")}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Iters */}
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground mb-1">
              Iters ({sessionIters.length})
            </div>
            {sessionIters.length === 0 ? (
              <div className="text-[10.5px] text-muted-foreground italic">No iters yet.</div>
            ) : (
              <div className="space-y-0.5">
                {sessionIters.map((it) => (
                  <div key={it.iter_id} className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[11px] text-ink">{it.iter_id}</span>
                    <span
                      className={cn(
                        "text-[10px] uppercase tracking-[0.1em]",
                        it.state === "ready_to_validate"
                          ? "text-[hsl(var(--sage))]"
                          : it.state === "running"
                            ? "text-[hsl(var(--ochre))]"
                            : it.state === "abandoned"
                              ? "text-muted-foreground"
                              : "text-ink",
                      )}
                    >
                      {it.state}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Skill snapshot pointer */}
          <div className="border-t border-border/60 pt-3">
            <button
              type="button"
              onClick={onJumpToAuthor}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-ink underline-offset-2 hover:underline"
            >
              <FileText size={11} strokeWidth={1.75} />
              Open skill rubric (AUTHOR)
            </button>
            <p className="mt-1 text-[10px] text-muted-foreground/80 leading-[1.4]">
              Edits made here affect THIS session's next iter — that's the inner loop.
            </p>
          </div>
        </div>
      )}
    </aside>
  );
}
