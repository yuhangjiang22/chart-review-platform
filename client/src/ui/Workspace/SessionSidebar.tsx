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

import { useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronLeft, FileText, ChevronDown, PanelRightClose } from "lucide-react";
import { authFetch } from "../../auth";
import { useDeepagentsModels } from "../../useDeepagentsModels";
import { TaskToolsPanel } from "./TaskToolsPanel";
import { VersionHistory } from "./VersionHistory";

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
  /** Session-scoped rubric fork: baseline it forked from + active version. */
  rubric?: { based_on: string; active_version: string };
}

interface IterShape {
  iter_id: string;
  iter_num: number;
  state: string;
  started_at: string;
  guideline_sha?: string;
  /** Friendly rubric version this iter ran on, snapshotted at run time. */
  rubric?: { based_on: string; active_version: string };
}

interface SessionSidebarProps {
  taskId: string;
  activeSessionId: string | null;
  /** Iters that belong to the active session (filtered upstream). */
  sessionIters: IterShape[];
  /** Which iter the workspace currently considers "active" (drives
   *  the visual highlight in the iter list). */
  activeIterId?: string | null;
  /** Per-patient validation status (oracle_done flag). Drives the
   *  cohort row badges. Keyed by patient_id. */
  patientStatus: Record<string, { oracle_done: boolean; errored?: boolean }>;
  isOpen: boolean;
  onToggle: () => void;
  /** Navigate to AUTHOR phase (skill snapshot link). */
  onJumpToAuthor: () => void;
  /** task_kind drives agent-vs-reviewer terminology, matching the
   *  PhaseTry pane. NER = reviewers (direct LLM); pheno/adh = agents
   *  (agent loop). */
  taskKind?: "phenotype" | "ner" | "adherence";
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
  taskId, activeSessionId, sessionIters, activeIterId,
  patientStatus, isOpen, onToggle, onJumpToAuthor, taskKind,
}: SessionSidebarProps) {
  const agentSectionLabel = taskKind === "ner" ? "Reviewers" : "Agents";
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

  // Resolve an agent's actual model: an un-pinned spec (no model) runs on the
  // registry default, so show that real model id rather than a "(env default)"
  // placeholder.
  const { defaultModelId } = useDeepagentsModels();

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
      {/* Minimal top gutter — just the collapse affordance. The session
          name + state below carry the identification; an additional
          "SESSION" label would just duplicate the top-bar switcher. */}
      <div className="flex items-center justify-end px-2 pt-2 pb-1">
        <button
          type="button"
          onClick={onToggle}
          className="p-1 rounded hover:bg-paper/80 text-muted-foreground hover:text-ink"
          aria-label="Collapse session sidebar"
          title="Collapse sidebar"
        >
          <PanelRightClose size={14} strokeWidth={1.75} />
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

          {/* Cohort — expandable per-patient file tree */}
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground mb-1">
              Cohort ({session.cohort.patient_ids.length})
            </div>
            <div className="space-y-0.5 max-h-[280px] overflow-y-auto">
              {session.cohort.patient_ids.map((pid) => (
                <PatientRow
                  key={pid}
                  patientId={pid}
                  status={patientStatus[pid]}
                />
              ))}
            </div>
          </div>

          {/* Agents / Reviewers — label tracks task_kind (parity with TRY pane) */}
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground mb-1">
              {agentSectionLabel} ({specs.length})
            </div>
            {specs.length === 0 ? (
              <div className="text-[10.5px] text-muted-foreground italic">
                No {agentSectionLabel.toLowerCase()} locked.
              </div>
            ) : (
              <div className="space-y-1 text-[11px] font-mono">
                {specs.map((s) => (
                  <div key={s.id} className="leading-[1.35]">
                    <span className="text-muted-foreground">{s.id}:</span>{" "}
                    <span className="break-words">
                      {[s.search_mode_preset, s.interpretation_preset,
                        s.model || defaultModelId || "(no model configured)"]
                        .filter(Boolean).join(" · ")}
                    </span>
                  </div>
                ))}
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
                {(() => {
                  // Iter ids are globally unique per task (storage keys), but
                  // within a session we present them as "Run 1, 2, …" so the
                  // count reads as session-relative.
                  const byNum = [...sessionIters].sort((a, b) => a.iter_num - b.iter_num);
                  const runNumberOf = new Map(byNum.map((it, i) => [it.iter_id, i + 1]));
                  // Validation is per-patient (session-scoped), not per-run — so
                  // a fresh run inherits the cohort's existing validations. Only
                  // surface "validating" when a patient is genuinely still
                  // pending; once every patient is validated the run is just the
                  // active "in progress" run (nothing left to validate).
                  const patientVals = Object.values(patientStatus);
                  const someUnvalidated =
                    patientVals.length > 0 && patientVals.some((s) => !s.oracle_done);
                  const labelForState = (state: string) =>
                    state === "validating" || state === "ready_to_validate"
                      ? someUnvalidated
                        ? "validating"
                        : "in progress"
                      : state;
                  return sessionIters.map((it) => {
                  const isActive = it.iter_id === activeIterId;
                  return (
                    <div
                      key={it.iter_id}
                      className={cn(
                        "flex items-baseline justify-between gap-2 px-1.5 py-0.5 rounded",
                        isActive && "bg-[hsl(var(--sage))]/10 border-l-2 border-[hsl(var(--sage))] pl-1",
                      )}
                    >
                      <span className={cn(
                        "font-mono text-[11px]",
                        isActive ? "text-ink font-medium" : "text-ink",
                      )}>
                        Run {runNumberOf.get(it.iter_id)}
                        {isActive && <span className="ml-1 text-[9px] text-[hsl(var(--sage))] uppercase tracking-[0.1em]">· active</span>}
                        {(() => {
                          // Prefer the friendly version label the run was frozen
                          // against (e.g. "s1"). Legacy iters predate that
                          // snapshot — fall back to the session's current version
                          // (best-effort), then to the raw content sha.
                          const fromIter = it.rubric?.active_version;
                          const ver = fromIter ?? session?.rubric?.active_version;
                          const basedOn = it.rubric?.based_on ?? session?.rubric?.based_on;
                          if (ver) {
                            const shaPart = it.guideline_sha ? ` · sha ${it.guideline_sha.slice(0, 8)}` : "";
                            const approx = fromIter ? "" : " (session's current version)";
                            return (
                              <span
                                className="ml-2 font-normal text-[9.5px] text-muted-foreground/70"
                                title={`Rubric version ${ver}${basedOn ? ` (forked from ${basedOn})` : ""}${approx}${shaPart}`}
                              >
                                rubric {ver}
                              </span>
                            );
                          }
                          if (it.guideline_sha) {
                            return (
                              <span
                                className="ml-2 font-normal text-[9.5px] text-muted-foreground/70"
                                title={`Rubric content hash this run was frozen against (guideline_sha): ${it.guideline_sha}`}
                              >
                                rubric {it.guideline_sha.slice(0, 8)}
                              </span>
                            );
                          }
                          return null;
                        })()}
                      </span>
                      <span
                        className={cn(
                          "text-[10px] uppercase tracking-[0.1em]",
                          it.state === "ready_to_validate" && someUnvalidated
                            ? "text-[hsl(var(--sage))]"
                            : it.state === "running"
                              ? "text-[hsl(var(--ochre))]"
                              : it.state === "abandoned"
                                ? "text-muted-foreground"
                                : "text-ink",
                        )}
                      >
                        {labelForState(it.state)}
                      </span>
                    </div>
                  );
                  });
                })()}
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
              Open skill rubric
            </button>
            <p className="mt-1 text-[10px] text-muted-foreground/80 leading-[1.4]">
              Edits made here affect THIS session's next iter — that's the inner loop.
            </p>
            {/* Rubric version timeline — shown on every tab's sidebar (the Refine
                tab hides the sidebar and renders its own copy in the workspace). */}
            {activeSessionId && <VersionHistory taskId={taskId} sessionId={activeSessionId} />}
            <TaskToolsPanel taskId={taskId} />
          </div>
        </div>
      )}
    </aside>
  );
}

interface NoteListing { filename: string; date?: string; doctype?: string }

function PatientRow({
  patientId, status,
}: { patientId: string; status?: { oracle_done: boolean; errored?: boolean } }) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState<NoteListing[] | null>(null);
  const [omopTables, setOmopTables] = useState<Array<{ name: string; rows: number }> | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (notes !== null && omopTables !== null) return;
    setLoading(true);
    try {
      const [notesR, structR] = await Promise.all([
        authFetch(`/api/patients/${encodeURIComponent(patientId)}/notes`)
          .then((r) => (r.ok ? r.json() : [])),
        authFetch(`/api/patients/${encodeURIComponent(patientId)}/structured`)
          .then((r) => (r.ok ? r.json() : null)),
      ]);
      setNotes(Array.isArray(notesR) ? notesR : []);
      if (structR && typeof structR === "object") {
        const tables: Array<{ name: string; rows: number }> = [];
        for (const [k, v] of Object.entries(structR)) {
          if (Array.isArray(v)) tables.push({ name: k, rows: v.length });
        }
        tables.sort((a, b) => a.name.localeCompare(b.name));
        setOmopTables(tables);
      } else {
        setOmopTables([]);
      }
    } finally {
      setLoading(false);
    }
  }, [patientId, notes, omopTables]);

  const tone = status?.errored
    ? "text-[hsl(var(--oxblood))]"
    : status?.oracle_done
      ? "text-[hsl(var(--sage))]"
      : "text-muted-foreground";
  const dot = status?.errored
    ? "bg-[hsl(var(--oxblood))]"
    : status?.oracle_done
      ? "bg-[hsl(var(--sage))]"
      : "bg-muted-foreground/30";

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next) void load();
        }}
        className="w-full flex items-center gap-1.5 py-0.5 hover:bg-paper/60 rounded"
      >
        {expanded
          ? <ChevronDown size={10} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
          : <ChevronRight size={10} strokeWidth={1.75} className="text-muted-foreground shrink-0" />}
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", dot)} />
        <span className={cn("font-mono text-[11px] truncate text-left", tone)}>{patientId}</span>
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 mb-1 space-y-1">
          {loading && (
            <div className="text-[10px] text-muted-foreground italic">loading…</div>
          )}
          {!loading && notes && (
            <div>
              <div className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground/80">
                notes ({notes.length})
              </div>
              {notes.length === 0 ? (
                <div className="text-[10px] text-muted-foreground/70 italic ml-1">no notes</div>
              ) : (
                <div className="ml-1 space-y-px">
                  {notes.map((n) => (
                    <div key={n.filename} className="font-mono text-[10px] text-muted-foreground truncate">
                      {n.filename}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {!loading && omopTables && (
            <div>
              <div className="text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground/80">
                omop ({omopTables.length})
              </div>
              {omopTables.length === 0 ? (
                <div className="text-[10px] text-muted-foreground/70 italic ml-1">no structured data</div>
              ) : (
                <div className="ml-1 space-y-px">
                  {omopTables.map((t) => (
                    <div key={t.name} className="font-mono text-[10px] text-muted-foreground">
                      {t.name} <span className="text-muted-foreground/60">({t.rows})</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
