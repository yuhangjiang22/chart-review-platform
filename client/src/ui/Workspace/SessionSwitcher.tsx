// SessionSwitcher — top-bar dropdown showing the active session, the list
// of active/archived sessions, and a "Start new session" CTA.
//
// Sessions are a fixed-cohort grouping above iters (see
// packages/domain-iter/src/sessions.ts). The synthetic session_legacy
// bucket holds iters that predate the session model.
//
// Active session is tracked by parent (Workspace) and persisted via
// localStorage with key chart-review:active-session:<taskId>.

import { useState, useRef, useEffect } from "react";
import { ChevronDown, Plus, Folders, Archive } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface SessionListItem {
  session: {
    session_id: string;
    session_num: number;
    name: string;
    state: "active" | "archived";
    started_at: string;
    cohort: { patient_ids: string[] };
  };
  iter_count: number;
  iter_ids: string[];
}

interface SessionSwitcherProps {
  sessions: SessionListItem[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNewSession: () => void;
  /** Archive an active session. When omitted (e.g. the viewer isn't a
   *  methodologist), rows render no archive affordance. */
  onArchive?: (sessionId: string) => void;
}

function fmtDate(iso: string): string {
  if (!iso || iso.startsWith("1970")) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function SessionSwitcher({
  sessions, activeSessionId, onSelect, onNewSession, onArchive,
}: SessionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const active = sessions.find((s) => s.session.session_id === activeSessionId);
  const activeName = active?.session.name ?? "(no session)";
  const activeSubtitle = active
    ? `${active.session.cohort.patient_ids.length} patient${active.session.cohort.patient_ids.length === 1 ? "" : "s"} · ${active.iter_count} iter${active.iter_count === 1 ? "" : "s"}`
    : "select or start a session";

  const activeSessions = sessions.filter((s) => s.session.state === "active");
  const archivedSessions = sessions.filter((s) => s.session.state === "archived");

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-2 rounded-md border border-border bg-paper/40 px-3 py-1.5 text-left transition-colors hover:bg-paper/60",
          "min-w-[200px]",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Folders size={13} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Session</div>
          <div className="text-[12.5px] font-medium truncate">{activeName}</div>
          <div className="text-[10px] text-muted-foreground truncate">{activeSubtitle}</div>
        </div>
        <ChevronDown size={13} strokeWidth={1.75} className={cn("text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          // Left-anchored: the switcher lives at the far left of the top bar, so
          // the menu opens rightward into open space — no viewport overflow / clip.
          className="absolute left-0 z-50 mt-1 w-[320px] max-w-[calc(100vw-2rem)] max-h-[400px] overflow-y-auto rounded-md border border-border bg-paper shadow-lg"
          role="listbox"
        >
          <div className="p-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start gap-1.5"
              onClick={() => { setOpen(false); onNewSession(); }}
            >
              <Plus size={12} />
              <span>Start new session</span>
            </Button>
          </div>

          {activeSessions.length > 0 && (
            <div>
              <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">Active</div>
              {activeSessions.map((s) => (
                <SessionRow
                  key={s.session.session_id}
                  item={s}
                  isActive={s.session.session_id === activeSessionId}
                  onClick={() => { setOpen(false); onSelect(s.session.session_id); }}
                  onArchive={onArchive}
                />
              ))}
            </div>
          )}

          {archivedSessions.length > 0 && (
            <div>
              <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">Archived</div>
              {archivedSessions.map((s) => (
                <SessionRow
                  key={s.session.session_id}
                  item={s}
                  isActive={s.session.session_id === activeSessionId}
                  onClick={() => { setOpen(false); onSelect(s.session.session_id); }}
                />
              ))}
            </div>
          )}

          {sessions.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">
              No sessions yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  item, isActive, onClick, onArchive,
}: {
  item: SessionListItem;
  isActive: boolean;
  onClick: () => void;
  onArchive?: (sessionId: string) => void;
}) {
  const name = item.session.name;
  // Archive is only meaningful for an active session; an archived session is
  // already read-only. The control is also absent when no handler is wired
  // (non-methodologist viewer).
  const canArchive = !!onArchive && item.session.state === "active";
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "w-full text-left px-3 py-2 border-l-2 transition-colors hover:bg-paper/60",
          canArchive && "pr-9",
          isActive
            ? "border-[hsl(var(--sage))] bg-[hsl(var(--sage))]/5"
            : "border-transparent",
        )}
        role="option"
        aria-selected={isActive}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-medium truncate">{name}</span>
          <span className="text-[9.5px] text-muted-foreground shrink-0">{fmtDate(item.session.started_at)}</span>
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {item.session.cohort.patient_ids.length === 0
            ? `${item.iter_count} iter${item.iter_count === 1 ? "" : "s"}`
            : `${item.session.cohort.patient_ids.length} patient${item.session.cohort.patient_ids.length === 1 ? "" : "s"} · ${item.iter_count} iter${item.iter_count === 1 ? "" : "s"}`}
        </div>
      </button>
      {canArchive && (
        <button
          type="button"
          aria-label={`Archive session ${name}`}
          title="Archive session"
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`Archive “${name}”? It becomes read-only; its iters are preserved.`)) {
              onArchive!(item.session.session_id);
            }
          }}
          className={cn(
            "absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-opacity",
            "hover:bg-paper hover:text-foreground",
            // Hidden until the row is hovered or the control is focused
            // (keyboard-reachable).
            "opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Archive size={13} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
