import { useEffect, useMemo, useState } from "react";
import { authFetch } from "./auth";
import { withSession } from "./active-session";
import { Pill } from "./atoms";

interface SessionSummary {
  session_id: string;
  entry_count: number;
  started_at?: string;
  ended_at?: string;
  bytes: number;
}

interface AuditEntry {
  ts: string;
  session_id: string;
  step_type: string;
  // Fields are union-typed on the server; we render whatever we get.
  [k: string]: unknown;
}

const STEP_COLORS: Record<string, string> = {
  session_start: "bg-muted/50 text-muted-foreground",
  user_message: "bg-secondary text-foreground",
  assistant_text: "bg-secondary text-foreground",
  tool_call_pre: "bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))]",
  tool_call_post: "bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))]",
  ui_action: "bg-[hsl(var(--sage)/0.10)] text-[hsl(var(--sage))]",
  state_write: "bg-violet-50 text-violet-700",
  result: "bg-muted text-foreground",
  error: "bg-[hsl(var(--oxblood)/0.10)] text-[hsl(var(--oxblood))]",
  // Phase B step types — rendered with sensible defaults until they land
  accept_agent_draft: "bg-[hsl(var(--sage)/0.10)] text-[hsl(var(--sage))]",
  bulk_accept: "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]",
  record_validated: "bg-teal-100 text-teal-800",
  blind_submit: "bg-purple-50 text-purple-700",
  reviewer_session_summary: "bg-muted text-foreground",
};

export function AuditView({ patientId, taskId }: { patientId: string; taskId: string }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [stepFilter, setStepFilter] = useState<string>("all");
  const [fieldFilter, setFieldFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  useEffect(() => {
    if (!patientId || !taskId) return;
    setActiveSession(null);
    setEntries([]);
    authFetch(withSession(`/api/reviews/${patientId}/${taskId}/audit`))
      .then((r) => r.json())
      .then((s: SessionSummary[]) => {
        setSessions(s);
        if (s.length > 0) setActiveSession(s[0].session_id);
      });
  }, [patientId, taskId]);

  useEffect(() => {
    if (!activeSession) return;
    setLoadingEntries(true);
    authFetch(withSession(`/api/reviews/${patientId}/${taskId}/audit/${activeSession}`))
      .then((r) => r.json())
      .then((d: { entries: AuditEntry[] }) => setEntries(d.entries ?? []))
      .finally(() => setLoadingEntries(false));
  }, [patientId, taskId, activeSession]);

  const stepTypes = useMemo(
    () => Array.from(new Set(entries.map((e) => e.step_type))).sort(),
    [entries],
  );

  const fieldIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of entries) {
      const fid = (e as { field_id?: string }).field_id;
      if (fid) ids.add(fid);
    }
    return Array.from(ids).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (stepFilter !== "all" && e.step_type !== stepFilter) return false;
      if (fieldFilter && (e as { field_id?: string }).field_id !== fieldFilter) return false;
      if (search) {
        const blob = JSON.stringify(e).toLowerCase();
        if (!blob.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [entries, stepFilter, fieldFilter, search]);

  return (
    <div className="p-4 space-y-3 text-[13px]">
      {/* Session + filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          className="border rounded px-2 py-1"
          value={activeSession ?? ""}
          onChange={(e) => setActiveSession(e.target.value)}
          aria-label="Audit session"
        >
          {sessions.map((s) => (
            <option key={s.session_id} value={s.session_id}>
              {(s.started_at ?? s.session_id).slice(0, 19)} · {s.entry_count}
            </option>
          ))}
        </select>

        <select
          className="border rounded px-2 py-1"
          value={stepFilter}
          onChange={(e) => setStepFilter(e.target.value)}
          aria-label="Filter by step type"
        >
          <option value="all">All step types</option>
          {stepTypes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          className="border rounded px-2 py-1"
          value={fieldFilter}
          onChange={(e) => setFieldFilter(e.target.value)}
          aria-label="Filter by field id"
        >
          <option value="">All fields</option>
          {fieldIds.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>

        <input
          className="border rounded px-2 py-1 flex-1 min-w-[8rem]"
          placeholder="search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search audit entries"
        />

        <Pill tone="neutral">
          {filtered.length} / {entries.length}
        </Pill>
      </div>

      {/* Entry list */}
      {loadingEntries ? (
        <p className="text-xs text-muted-foreground/70">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">
          No chat sessions yet for this patient×task. Send a message in the Agent panel and
          refresh.
        </p>
      ) : (
        <ol className="space-y-1">
          {filtered.map((e, i) => (
            <li
              key={i}
              className={`px-2 py-1 rounded text-[12px] font-mono ${STEP_COLORS[e.step_type] ?? "bg-muted/50"}`}
            >
              <span className="opacity-60">{(e.ts ?? "").slice(11, 19)}</span>{" "}
              <strong>{e.step_type}</strong>{" "}
              <details className="inline">
                <summary className="cursor-pointer inline">payload</summary>
                <pre className="text-[11px] whitespace-pre-wrap break-all mt-1">
                  {JSON.stringify(e, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
