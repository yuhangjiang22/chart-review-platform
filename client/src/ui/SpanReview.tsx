// SpanReview — MVP NER reviewer surface (ported from v2).
//
// Mounted in App.tsx when the active task's `task_type === "ner"`.
// Parallel to PatientReview (which is criterion-row for phenotype tasks),
// but spans don't have a fixed rubric — they're a free-form list grouped
// by note_id.
//
// MVP surface (per docs/superpowers/plans/2026-06-11-ner-task-kind.md, N4):
//   - Fetch GET /api/reviews/:patientId/:taskId, read span_labels[]
//   - Render a table grouped by note_id, columns:
//       text · anchor · offsets · entity_type · concept_name · status ·
//       proposed_by · actions
//   - Per-span Accept (→ PATCH status=mapped) / Reject (→ status=rejected)
//   - Per-span concept_name inline edit + Delete
//   - Per-note "mark validated" → POST .../notes/:noteId/validation
//   - ±context snippet: the note text around each note's spans (read-only)
//   - Export the span_labels[] as JSON
//
// Session scoping: concur REQUIRES `session_id` on every review-state
// read/write (server `sessionIdOf` throws 400 when it is absent — same as
// PatientReview's calls). v2's `withSession` helper does not exist here;
// instead the caller threads `activeSessionId` and every call appends
// `?session_id=<sid>` inline, matching PatientReview's convention.
//
// Deliberately NOT ported from v2 (depends on pieces concur's MVP lacks):
//   - NoteWithHighlights drag-to-create overlay + NewSpanPopover — the
//     popover reads /api/tasks/:taskId/entity-type-guidance, which concur
//     does not expose. The context snippet replaces the highlight overlay.
//   - ImportAgentDraftCard — concur auto-imports agent drafts into the
//     session-scoped reviews root, so the empty state is just a message.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Check, X, ChevronDown, ChevronRight, Download,
  CheckCircle2, Circle,
} from "lucide-react";
import { authFetch } from "../auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SpanLabel {
  span_id: string;
  note_id: string;
  text: string;
  anchor: string;
  start: number;
  end: number;
  entity_type: string;
  concept_name: string;
  status?: "mapped" | "novel_candidate" | "rejected";
  override_reason?: string;
  /** Which agent(s) proposed this span. "reviewer" for spans the human
   *  added via the SpanReview UI. */
  proposed_by?: string[];
}

interface SpanReviewState {
  patient_id: string;
  task_id: string;
  version: number;
  span_labels?: SpanLabel[];
  validated_notes?: string[];
  review_status?: string;
  /** Set by the run-import step to the run_id whose drafts seeded this state.
   *  Used as the guard for seed-on-empty: a state that was already imported
   *  (even if the reviewer later cleared every span) is never re-seeded. */
  imported_from_run?: string;
}

export interface SpanReviewProps {
  patientId: string;
  patientDisplay: string;
  taskId: string;
  onBack: () => void;
  /** Active workspace session id. Appended as ?session_id=<sid> on all
   *  review-state reads and writes so they hit the session-scoped root.
   *  Required by the server — calls without it return 400. The caller must
   *  ensure a session is active before opening this surface. */
  activeSessionId?: string | null;
}

export function SpanReview({ patientId, patientDisplay, taskId, onBack, activeSessionId }: SpanReviewProps) {
  const [state, setState] = useState<SpanReviewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Track whether we've auto-expanded the first note for this
  // patient × task. Without this, the auto-expand fires on every
  // collapse-to-empty (refresh's `expanded.size === 0` guard would
  // pop the note back open whenever the user closed the last open one).
  const didAutoExpandRef = useRef(false);
  // Track whether we've already attempted to seed the review state from a
  // completed agent run for this patient × task. The agent's NER spans live
  // in the run draft (var/runs/.../agents/agent_1.json) until imported into
  // the session review state; App.tsx auto-imports on patient-open, but its
  // 3-call chain (list runs → import → refresh) reliably loses the race to
  // this pane's single review fetch, so on first open we'd render empty.
  // We self-seed once: if the fetch comes back with no spans AND the state
  // was never imported, pull the latest session run's draft in ourselves.
  const seedAttemptedRef = useRef(false);
  // Cancellation token for the recursive refresh() seed chain. The driving
  // effect owns it: bumped on (re)run and on cleanup, so switching patients
  // mid-flight makes captured tokens stale → every setState in refresh()
  // becomes a no-op (no setState-after-unmount, no cross-patient clobber).
  const refreshTokenRef = useRef(0);

  // session_id is required on every review call; build the query suffix
  // once. `&` form is unused here since none of these URLs carry another
  // query param, but keep the `?` form explicit for clarity.
  const sessionQs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";

  useEffect(() => {
    didAutoExpandRef.current = false;
    seedAttemptedRef.current = false;
    setExpanded(new Set());
  }, [patientId, taskId]);

  const refresh = useCallback(async (token: number = refreshTokenRef.current) => {
    const live = () => refreshTokenRef.current === token;
    setLoading(true);
    try {
      const r = await authFetch(
        `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}${sessionQs}`,
      );
      if (!live()) return;
      if (!r.ok) {
        setError(`load failed: ${r.status}`);
        setState(null);
        return;
      }
      const body = (await r.json()) as SpanReviewState;
      if (!live()) return;
      setState(body);
      setError(null);
      // Seed-on-empty: the agent's NER spans live in the run draft until
      // imported into the session review state. If the state is empty AND
      // was never imported, pull the latest session run's draft in ourselves
      // (once), then re-render. Guarded by `imported_from_run` so a reviewer
      // who deliberately cleared every span isn't re-seeded, and by
      // `seedAttemptedRef` so a genuinely empty run doesn't loop.
      if (
        (!body.span_labels || body.span_labels.length === 0)
        && !body.imported_from_run
        && activeSessionId
        && !seedAttemptedRef.current
      ) {
        seedAttemptedRef.current = true;
        const runsRes = await authFetch(
          `/api/runs?task_id=${encodeURIComponent(taskId)}&session_id=${encodeURIComponent(activeSessionId)}`,
        );
        if (!live()) return;
        const runs: Array<{ run_id: string }> = runsRes.ok ? await runsRes.json() : [];
        for (const run of runs) {
          const imp = await authFetch(
            `/api/runs/${encodeURIComponent(run.run_id)}/patients/${encodeURIComponent(patientId)}/import`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ force: true }),
            },
          );
          if (!live()) return;
          if (imp.ok) {
            await refresh(token);
            return;
          }
        }
      }
      // Expand the first note by default ONCE per (patient, task) so the
      // initial render isn't a wall of collapsed headers. After that, the
      // user's expanded/collapsed choices win — including collapsing
      // everything. Expand the SORTED-first note (min note_id), matching the
      // order the notes render in (noteIds[0]) — not body.span_labels[0],
      // which is raw array order and may differ.
      if (
        !didAutoExpandRef.current
        && body.span_labels
        && body.span_labels.length > 0
      ) {
        const firstNote = body.span_labels
          .map((s) => s.note_id)
          .sort()[0]!;
        setExpanded(new Set([firstNote]));
        didAutoExpandRef.current = true;
      }
    } catch (e) {
      if (!live()) return;
      setError(`load error: ${(e as Error).message}`);
      setState(null);
    } finally {
      if (live()) setLoading(false);
    }
  }, [patientId, taskId, sessionQs, activeSessionId]);

  useEffect(() => {
    const token = ++refreshTokenRef.current;
    void refresh(token);
    // Bump the token on cleanup so any in-flight refresh() for this run stops
    // calling setState (unmount + patient/task switch both trigger this).
    return () => { refreshTokenRef.current++; };
  }, [refresh]);

  async function patchSpan(
    spanId: string,
    patch: { status?: SpanLabel["status"]; concept_name?: string; override_reason?: string },
  ): Promise<void> {
    try {
      const r = await authFetch(
        `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/spans/${encodeURIComponent(spanId)}${sessionQs}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({ error: r.statusText }))) as {
          error?: string;
          payload?: { error?: string };
        };
        const msg = body.payload?.error ?? body.error ?? `patch failed: ${r.status}`;
        setError(msg);
        return;
      }
      await refresh();
    } catch (e) {
      setError(`patch error: ${(e as Error).message}`);
    }
  }

  async function setNoteValidation(noteId: string, validated: boolean): Promise<void> {
    try {
      const r = await authFetch(
        `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/notes/${encodeURIComponent(noteId)}/validation${sessionQs}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ validated }),
        },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({ error: r.statusText }))) as {
          error?: string;
          payload?: { error?: string };
        };
        setError(body.payload?.error ?? body.error ?? `validation failed: ${r.status}`);
        return;
      }
      await refresh();
    } catch (e) {
      setError(`validation error: ${(e as Error).message}`);
    }
  }

  const spans = state?.span_labels ?? [];
  const byNote = new Map<string, SpanLabel[]>();
  for (const s of spans) {
    const arr = byNote.get(s.note_id) ?? [];
    arr.push(s);
    byNote.set(s.note_id, arr);
  }
  for (const arr of byNote.values()) {
    arr.sort((a, b) => a.start - b.start);
  }
  const noteIds = [...byNote.keys()].sort();

  function toggleNote(noteId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }

  function exportJson() {
    if (!state) return;
    const payload = {
      patient_id: patientId,
      task_id: taskId,
      version: state.version,
      exported_at: new Date().toISOString(),
      span_labels: spans,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ner_${patientId}_${taskId}_v${state.version ?? "x"}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const isLocked = state?.review_status === "locked";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold">{patientDisplay}</div>
          <div className="text-[11.5px] text-muted-foreground">
            {taskId} · NER · {spans.length} span{spans.length === 1 ? "" : "s"} across {noteIds.length} note{noteIds.length === 1 ? "" : "s"}
            {state?.version !== undefined ? ` · v${state.version}` : ""}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={exportJson}
          disabled={!state || spans.length === 0}
          title="Download span_labels JSON"
        >
          <Download className="size-4" /> Export JSON
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-[hsl(var(--oxblood))]/10 text-[hsl(var(--oxblood))] text-[12px]">
          {error}
        </div>
      )}

      {/* Empty / loading states */}
      {loading && !state && (
        <div className="px-4 py-6 text-[13px] text-muted-foreground italic">Loading…</div>
      )}
      {!loading && spans.length === 0 && (
        <div className="m-4 p-4 border border-border rounded-md space-y-1">
          <div className="text-[13px] font-medium">No spans yet for this patient</div>
          <div className="text-[11.5px] text-muted-foreground">
            Run an NER agent in the TRY phase. The agent's draft spans are
            imported into this session automatically and will appear here for
            validation.
          </div>
        </div>
      )}

      {/* Spans grouped by note */}
      <div className="flex-1 overflow-y-auto">
        {noteIds.map((noteId) => {
          const noteSpans = byNote.get(noteId)!;
          const isOpen = expanded.has(noteId);
          const isValidated = (state?.validated_notes ?? []).includes(noteId);
          return (
            <div key={noteId} className="border-b border-border">
              <div className="w-full px-4 py-2 flex items-center gap-2 hover:bg-muted/40">
                <button
                  type="button"
                  onClick={() => toggleNote(noteId)}
                  className="flex-1 min-w-0 flex items-center gap-2 text-left"
                >
                  {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  <span className="font-mono text-[12.5px]">{noteId}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {noteSpans.length} span{noteSpans.length === 1 ? "" : "s"}
                  </span>
                </button>
                <Button
                  variant={isValidated ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setNoteValidation(noteId, !isValidated)}
                  disabled={loading || isLocked}
                  title={
                    isLocked
                      ? "Patient is locked"
                      : isValidated
                        ? "Mark this note as not yet validated"
                        : "Mark this note as validated"
                  }
                >
                  {isValidated
                    ? <><CheckCircle2 className="size-3.5" /> Validated</>
                    : <><Circle className="size-3.5" /> Mark validated</>}
                </Button>
              </div>
              {isOpen && (
                <NoteContextSnippet
                  patientId={patientId}
                  noteId={noteId}
                  spans={noteSpans}
                />
              )}
              {isOpen && (
                <table className="w-full text-[12px] border-t border-border/60">
                  <thead className="bg-muted/30 text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-1.5 w-[16%]">text</th>
                      <th className="text-left px-2 py-1.5 w-[14%]">anchor</th>
                      <th className="text-left px-2 py-1.5 w-[8%]">offsets</th>
                      <th className="text-left px-2 py-1.5 w-[14%]">entity_type</th>
                      <th className="text-left px-2 py-1.5 w-[14%]">concept_name</th>
                      <th className="text-left px-2 py-1.5 w-[8%]">status</th>
                      <th className="text-left px-2 py-1.5 w-[8%]">proposed by</th>
                      <th className="text-right px-4 py-1.5 w-[16%]">actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {noteSpans.map((s, idx) => (
                      <SpanRow
                        // Spans with an empty/missing span_id would collide on
                        // key — fall back to a stable note_id:start:end:idx.
                        key={s.span_id || `${s.note_id}:${s.start}:${s.end}:${idx}`}
                        span={s}
                        disabled={loading || isLocked}
                        onPatch={(patch) => patchSpan(s.span_id, patch)}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SpanRow({ span, disabled, onPatch }: {
  span: SpanLabel;
  disabled?: boolean;
  onPatch: (patch: { status?: SpanLabel["status"]; concept_name?: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(span.concept_name);
  // Only resync the draft from props when NOT editing. A background refresh()
  // (e.g. Accept/Reject on another row) re-fetches the whole span list and
  // re-renders every SpanRow; without this guard it would overwrite the
  // user's in-progress concept_name edit.
  useEffect(() => {
    if (!editing) setDraft(span.concept_name);
  }, [span.concept_name, editing]);
  const status = span.status ?? "mapped";
  return (
    <tr className="border-t border-border/40 hover:bg-muted/20 align-top">
      <td className="px-4 py-2 font-medium">{span.text}</td>
      <td className="px-2 py-2 text-muted-foreground italic">{span.anchor}</td>
      <td className="px-2 py-2 text-[10.5px] font-mono text-muted-foreground">[{span.start},{span.end})</td>
      <td className="px-2 py-2 text-[11px]">{span.entity_type}</td>
      <td className="px-2 py-2">
        {editing ? (
          <span className="flex gap-1">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="text-[11px] border border-border rounded px-1 py-0.5 w-full bg-background disabled:opacity-50"
              autoFocus
              disabled={disabled}
            />
            <Button
              size="sm" variant="ghost"
              onClick={() => {
                // Never save an empty concept_name — trim and bail on blank.
                const v = draft.trim();
                if (!v) return;
                onPatch({ concept_name: v });
                setEditing(false);
              }}
              disabled={disabled || draft.trim() === ""}
              title="Save"
            ><Check className="size-3" /></Button>
            <Button
              size="sm" variant="ghost"
              onClick={() => { setDraft(span.concept_name); setEditing(false); }}
              disabled={disabled}
              title="Cancel"
            ><X className="size-3" /></Button>
          </span>
        ) : (
          <button
            type="button"
            className="text-[11px] underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline"
            onClick={() => setEditing(true)}
            disabled={disabled}
          >
            {span.concept_name || <span className="italic text-muted-foreground">(none)</span>}
          </button>
        )}
      </td>
      <td className="px-2 py-2">
        <StatusBadge status={span.status} />
      </td>
      <td className="px-2 py-2">
        <ProvenanceBadges proposed_by={span.proposed_by} />
      </td>
      <td className="px-4 py-2 text-right">
        <div className="flex gap-1 justify-end">
          <Button
            size="sm" variant="ghost"
            onClick={() => onPatch({ status: "mapped" })}
            disabled={disabled || status === "mapped"}
            title="Accept this span (status → mapped)"
          ><Check className="size-3" /></Button>
          <Button
            size="sm" variant="ghost"
            onClick={() => onPatch({ status: "rejected" })}
            disabled={disabled || status === "rejected"}
            title="Reject this span (status → rejected)"
          ><X className="size-3" /></Button>
        </div>
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status?: SpanLabel["status"] }) {
  const s = status ?? "mapped";
  const color =
    s === "mapped" ? "bg-green-50 text-green-900 border-green-200"
    : s === "rejected" ? "bg-red-50 text-red-900 border-red-200"
    : "bg-amber-50 text-amber-900 border-amber-200";
  return (
    <span className={cn("inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-[0.1em] border", color)}>
      {s}
    </span>
  );
}

// Renders one chip per agent (e.g. "A1", "A2") so the reviewer can see
// at a glance whether a span came from one agent, both agents (an
// agreement), or was hand-added by the reviewer. Color encodes
// agreement: both-agents → green (consensus), single-agent → amber,
// reviewer-added → muted.
function ProvenanceBadges({ proposed_by }: { proposed_by?: string[] }) {
  const proposers = proposed_by ?? [];
  if (proposers.length === 0) {
    return <span className="text-[10px] italic text-muted-foreground">—</span>;
  }
  const agentIds = proposers.filter((p) => p !== "reviewer");
  const reviewerAdded = proposers.includes("reviewer");
  const isConsensus = agentIds.length >= 2;
  return (
    <div className="flex flex-wrap gap-1">
      {agentIds.map((id) => {
        // "agent_1" → "A1"; "agent" (legacy single) → "A"
        const short = id.startsWith("agent_") ? `A${id.slice(6)}` : id === "agent" ? "A" : id;
        const cls = isConsensus
          ? "bg-green-50 text-green-900 border-green-200"
          : "bg-amber-50 text-amber-900 border-amber-200";
        return (
          <span
            key={id}
            className={cn("inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-[0.1em] border", cls)}
            title={id}
          >
            {short}
          </span>
        );
      })}
      {reviewerAdded && (
        <span
          className="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-[0.1em] border bg-muted/40 text-muted-foreground border-border"
          title="reviewer-added"
        >
          R
        </span>
      )}
    </div>
  );
}

// ±context snippet: read-only view of the note text around this note's
// spans. Replaces v2's NoteWithHighlights drag-to-create overlay (which
// depends on the entity-type-guidance endpoint concur doesn't expose).
// Shows the raw note with each span's (start,end) range highlighted by
// status — enough context for the reviewer to judge each row.
const CONTEXT_PAD = 80;

function NoteContextSnippet({ patientId, noteId, spans }: {
  patientId: string;
  noteId: string;
  spans: SpanLabel[];
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const filename = noteId.endsWith(".txt") ? noteId : `${noteId}.txt`;
    authFetch(`/api/patients/${encodeURIComponent(patientId)}/notes/${encodeURIComponent(filename)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`note fetch failed: ${r.status}`);
        return r.text();
      })
      .then((t) => { if (!cancelled) setText(t); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [patientId, noteId]);

  if (error) {
    return <div className="px-4 py-2 text-[11px] text-[hsl(var(--oxblood))]">note: {error}</div>;
  }
  if (text === null) {
    return <div className="px-4 py-2 text-[11px] text-muted-foreground italic">Loading note…</div>;
  }

  return (
    <div className="px-4 py-3 bg-muted/10 border-t border-border/60 max-h-72 overflow-y-auto space-y-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        note · {noteId} · context
      </div>
      {spans.map((s, idx) => {
        // Clamp raw offsets before slicing: a negative `start` would slice
        // from the end of the string, and out-of-bounds / start>end would
        // mis-highlight. a = clamped start, b = clamped end (>= a).
        const a = Math.max(0, Math.min(s.start, text.length));
        const b = Math.max(a, Math.min(s.end, text.length));
        const from = Math.max(0, a - CONTEXT_PAD);
        const to = Math.min(text.length, b + CONTEXT_PAD);
        const before = text.slice(from, a);
        const hit = text.slice(a, b);
        const after = text.slice(b, to);
        const status = s.status ?? "mapped";
        const cls =
          status === "mapped" ? "bg-green-200/70 text-green-950"
          : status === "rejected" ? "bg-red-200/70 text-red-950 line-through"
          : "bg-amber-200/70 text-amber-950";
        return (
          <pre
            key={s.span_id || `${s.note_id}:${s.start}:${s.end}:${idx}`}
            className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed"
            title={`${s.entity_type} → ${s.concept_name || "(novel)"} [${s.start},${s.end})`}
          >
            {from > 0 ? "…" : ""}{before}
            <mark className={cn("rounded px-0.5", cls)}>{hit}</mark>
            {after}{to < text.length ? "…" : ""}
          </pre>
        );
      })}
    </div>
  );
}
