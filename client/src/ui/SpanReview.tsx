// SpanReview — MVP NER reviewer surface.
//
// Mounted in App.tsx when the active task's `task_kind === "ner"`.
// Parallel to PatientReview (which is criterion-row for phenotype tasks),
// but spans don't have a fixed rubric — they're a free-form list grouped
// by note_id.
//
// MVP scope per NER-INTEGRATION.md Phase 1.6:
//   - Fetch GET /api/reviews/:patientId/:taskId, read span_labels[]
//   - Render a flat table grouped by note_id, columns:
//       text · anchor · entity_type · concept_name · status · actions
//   - Per-span "Accept" + "Reject" buttons → PATCH /api/reviews/:patientId/:taskId/spans/:spanId
//   - Per-span concept_name inline edit (Phase 3 will add the rich
//     inline-highlighting note overlay; MVP shows a context snippet)
//
// What's deliberately NOT here (lands in Phase 3 / Track B):
//   - Inline overlapping-span rendering with click-to-edit on the note
//   - Multi-reviewer overlay
//   - LLM judge panel for span disagreements
//   - Bulk-accept

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, X, ChevronDown, ChevronRight, Download, CheckCircle2, Circle } from "lucide-react";
import { authFetch } from "../auth";
import { withSession } from "../active-session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

interface ReviewState {
  patient_id: string;
  task_id: string;
  version: number;
  span_labels?: SpanLabel[];
}

export interface SpanReviewProps {
  patientId: string;
  patientDisplay: string;
  taskId: string;
  onBack: () => void;
}

export function SpanReview({ patientId, patientDisplay, taskId, onBack }: SpanReviewProps) {
  const [state, setState] = useState<ReviewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Track whether we've auto-expanded the first note for this
  // patient × task. Without this, the auto-expand fires on every
  // collapse-to-empty (refresh's `expanded.size === 0` guard would
  // pop the note back open whenever the user closed the last open one).
  const didAutoExpandRef = useRef(false);
  useEffect(() => {
    didAutoExpandRef.current = false;
    setExpanded(new Set());
  }, [patientId, taskId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(
        withSession(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}`),
      );
      if (!r.ok) {
        setError(`load failed: ${r.status}`);
        setState(null);
        return;
      }
      const body = (await r.json()) as ReviewState;
      setState(body);
      setError(null);
      // Expand the first note by default ONCE per (patient, task) so the
      // initial render isn't a wall of collapsed headers. After that, the
      // user's expanded/collapsed choices win — including collapsing
      // everything.
      if (
        !didAutoExpandRef.current
        && body.span_labels
        && body.span_labels.length > 0
      ) {
        setExpanded(new Set([body.span_labels[0]!.note_id]));
        didAutoExpandRef.current = true;
      }
    } catch (e) {
      setError(`load error: ${(e as Error).message}`);
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [patientId, taskId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function patchSpan(
    spanId: string,
    patch: { status?: SpanLabel["status"]; concept_name?: string; override_reason?: string },
  ): Promise<void> {
    try {
      const r = await authFetch(
        withSession(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/spans/${encodeURIComponent(spanId)}`),
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
        withSession(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/notes/${encodeURIComponent(noteId)}/validation`),
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

  async function deleteSpan(spanId: string): Promise<void> {
    try {
      const r = await authFetch(
        withSession(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/spans/${encodeURIComponent(spanId)}`),
        { method: "DELETE" },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({ error: r.statusText }))) as {
          error?: string;
          payload?: { error?: string };
        };
        setError(body.payload?.error ?? body.error ?? `delete failed: ${r.status}`);
        return;
      }
      await refresh();
    } catch (e) {
      setError(`delete error: ${(e as Error).message}`);
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
          title="Download review_state.json"
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
        <ImportAgentDraftCard
          patientId={patientId}
          taskId={taskId}
          onImported={refresh}
        />
      )}

      {/* Spans grouped by note */}
      <div className="flex-1 overflow-y-auto">
        {noteIds.map((noteId) => {
          const noteSpans = byNote.get(noteId)!;
          const isOpen = expanded.has(noteId);
          const isValidated = (state?.validated_notes ?? []).includes(noteId);
          const isLocked = state?.review_status === "locked";
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
                <NoteWithHighlights
                  patientId={patientId}
                  taskId={taskId}
                  noteId={noteId}
                  spans={noteSpans}
                  onSpanCreated={refresh}
                  syncing={loading}
                />
              )}
              {isOpen && (
                <table className="w-full text-[12px] border-t border-border/60">
                  <thead className="bg-muted/30 text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-1.5 w-[16%]">text</th>
                      <th className="text-left px-2 py-1.5 w-[16%]">anchor</th>
                      <th className="text-left px-2 py-1.5 w-[10%]">offsets</th>
                      <th className="text-left px-2 py-1.5 w-[16%]">entity_type</th>
                      <th className="text-left px-2 py-1.5 w-[14%]">concept_name</th>
                      <th className="text-left px-2 py-1.5 w-[10%]">status</th>
                      <th className="text-left px-2 py-1.5 w-[10%]">proposed by</th>
                      <th className="text-right px-4 py-1.5 w-[8%]">actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {noteSpans.map((s) => <SpanRow key={s.span_id} span={s} disabled={loading} onPatch={(patch) => patchSpan(s.span_id, patch)} onDelete={() => deleteSpan(s.span_id)} />)}
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

function SpanRow({ span, disabled, onPatch, onDelete }: {
  span: SpanLabel;
  disabled?: boolean;
  onPatch: (patch: { status?: SpanLabel["status"]; concept_name?: string }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(span.concept_name);
  useEffect(() => { setDraft(span.concept_name); }, [span.concept_name]);
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
              onClick={() => { onPatch({ concept_name: draft }); setEditing(false); }}
              disabled={disabled}
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
            onClick={onDelete}
            disabled={disabled}
            title="Delete this span"
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

// Shown in SpanReview when the patient × task has no spans committed
// yet. Lists this patient's recent NER runs and lets the reviewer
// import the agent draft into reviews/ so they have something to
// validate. Without this affordance the reviewer would hit a dead end
// on a freshly-finished agent run.
function ImportAgentDraftCard({
  patientId, taskId, onImported,
}: {
  patientId: string;
  taskId: string;
  onImported: () => void;
}) {
  const [runs, setRuns] = useState<Array<{ run_id: string; started_at: string; spans?: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/runs?task_id=${encodeURIComponent(taskId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Array<{ run_id: string; started_at: string; patient_ids: string[] }> | null) => {
        if (cancelled || !d || !Array.isArray(d)) return;
        // Filter to runs that include this patient.
        const filtered = d
          .filter((r) => Array.isArray(r.patient_ids) && r.patient_ids.includes(patientId))
          .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
          .slice(0, 5)
          .map((r) => ({ run_id: r.run_id, started_at: r.started_at }));
        setRuns(filtered);
      })
      .catch((e) => setError(`failed to list runs: ${(e as Error).message}`));
    return () => { cancelled = true; };
  }, [patientId, taskId]);

  async function importDraft(runId: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/runs/${encodeURIComponent(runId)}/patients/${encodeURIComponent(patientId)}/import`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as {
          error?: string;
          payload?: { error?: string };
        };
        setError(body.payload?.error ?? body.error ?? `import failed: ${r.status}`);
        return;
      }
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="m-4 p-4 border border-border rounded-md space-y-2">
      <div className="text-[13px] font-medium">No spans yet for this patient</div>
      <div className="text-[11.5px] text-muted-foreground">
        Run an NER agent in the TRY phase, then import the agent's draft here so you can validate it.
      </div>
      {runs.length === 0 && (
        <div className="text-[11.5px] text-muted-foreground italic">
          No agent runs found for this patient + task yet.
        </div>
      )}
      {runs.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
            Recent runs for this patient
          </div>
          {runs.map((r) => (
            <div key={r.run_id} className="flex items-center justify-between gap-2 text-[11.5px]">
              <div className="font-mono">{r.run_id}</div>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => importDraft(r.run_id)}>
                {busy ? "Importing…" : "Import draft"}
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="text-[11.5px] text-[hsl(var(--oxblood))]">{error}</div>
      )}
    </div>
  );
}

// Renders a note's raw text inline with each span highlighted at its
// (start, end) byte range. Overlapping spans are handled by greedy
// segmentation: at every span boundary the rendering breaks into a new
// chunk; chunks inside one span pick up that span's color, chunks
// inside multiple spans pick the first-listed (caller pre-sorts).
//
// MVP scope (Phase 3.3): per-note highlight, single reviewer overlay.
// Phase 4 (out of plan): multi-reviewer overlay, click-to-edit-on-note.
function NoteWithHighlights({
  patientId, taskId, noteId, spans, onSpanCreated, syncing,
}: {
  patientId: string;
  taskId: string;
  noteId: string;
  spans: SpanLabel[];
  onSpanCreated: () => void;
  /** When true, the parent SpanReview is mid-refresh — block new span
   *  creation and close any open popover so we don't race the in-flight
   *  refresh (which would overwrite local state with stale server data). */
  syncing?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<{
    start: number; end: number; text: string;
  } | null>(null);
  const noteRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/patients/${encodeURIComponent(patientId)}/notes/${encodeURIComponent(noteId)}.txt`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`note fetch failed: ${r.status}`);
        return r.text();
      })
      .then((t) => { if (!cancelled) setText(t); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [patientId, noteId]);

  // Auto-close popover when sync starts so a fresh refresh can't race a
  // create. The user can re-select after sync finishes.
  useEffect(() => {
    if (syncing) setPendingSelection(null);
  }, [syncing]);

  // Capture text selection inside the note and resolve it to absolute
  // (start, end) in the raw note bytes. Each rendered segment carries
  // a `data-start` attribute = its absolute offset in `text`, so the
  // selection's anchor/focus offsets within a node combine with the
  // parent's data-start to give the absolute position.
  function captureSelection() {
    // Block during refresh so the create popover doesn't fire while
    // the table state is being refetched.
    if (syncing) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !noteRef.current) {
      setPendingSelection(null);
      return;
    }
    // Both endpoints must be within the note container.
    if (!noteRef.current.contains(sel.anchorNode) || !noteRef.current.contains(sel.focusNode)) {
      setPendingSelection(null);
      return;
    }
    const resolve = (node: Node | null, offset: number): number | null => {
      let el: HTMLElement | null = node instanceof HTMLElement ? node : node?.parentElement ?? null;
      while (el && !el.dataset.start && el !== noteRef.current) el = el.parentElement;
      if (!el || !el.dataset.start) return null;
      return Number(el.dataset.start) + offset;
    };
    let a = resolve(sel.anchorNode, sel.anchorOffset);
    let b = resolve(sel.focusNode, sel.focusOffset);
    if (a === null || b === null) { setPendingSelection(null); return; }
    if (a > b) [a, b] = [b, a];
    if (a === b) { setPendingSelection(null); return; }
    if (!text) return;
    const selected = text.slice(a, b);
    if (!selected.trim()) { setPendingSelection(null); return; }
    setPendingSelection({ start: a, end: b, text: selected });
  }

  if (error) {
    return <div className="px-4 py-2 text-[11px] text-[hsl(var(--oxblood))]">note: {error}</div>;
  }
  if (text === null) {
    return <div className="px-4 py-2 text-[11px] text-muted-foreground italic">Loading note…</div>;
  }

  // Greedy segmentation: at every span start/end, break the text into
  // a chunk. Each chunk records which spans cover it (usually 0 or 1;
  // more when spans overlap).
  const breakpoints = new Set<number>([0, text.length]);
  for (const s of spans) { breakpoints.add(s.start); breakpoints.add(s.end); }
  const ordered = [...breakpoints].sort((a, b) => a - b);
  const segments: Array<{ start: number; end: number; covers: SpanLabel[] }> = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    if (a >= b) continue;
    const covers = spans.filter((s) => s.start <= a && s.end >= b);
    segments.push({ start: a, end: b, covers });
  }

  return (
    <div className="px-4 py-3 bg-muted/10 border-t border-border/60 max-h-72 overflow-y-auto relative">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          note · {noteId}
        </div>
        <div className="text-[10px] text-muted-foreground italic">
          {syncing ? "Syncing — please wait…" : "Drag-select text to create a span"}
        </div>
      </div>
      <pre
        ref={noteRef}
        onMouseUp={captureSelection}
        className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed select-text cursor-text"
      >
        {segments.map((seg, i) => {
          const slice = text.slice(seg.start, seg.end);
          if (seg.covers.length === 0) {
            return <span key={i} data-start={seg.start}>{slice}</span>;
          }
          const s = seg.covers[0]!;
          const status = s.status ?? "mapped";
          const cls =
            status === "mapped" ? "bg-green-200/70 text-green-950"
            : status === "rejected" ? "bg-red-200/70 text-red-950 line-through"
            : "bg-amber-200/70 text-amber-950";
          const title = `${s.entity_type} → ${s.concept_name || "(novel)"}  [${s.start},${s.end})`;
          return (
            <mark key={i} className={cn("rounded px-0.5", cls)} title={title} data-start={seg.start}>
              {slice}
            </mark>
          );
        })}
      </pre>
      {pendingSelection && (
        <NewSpanPopover
          patientId={patientId}
          taskId={taskId}
          noteId={noteId}
          selection={pendingSelection}
          onClose={() => setPendingSelection(null)}
          onCreated={() => { setPendingSelection(null); onSpanCreated(); }}
        />
      )}
    </div>
  );
}

// Popover shown after the reviewer drag-selects text in NoteWithHighlights.
// Captures entity_type (from the active ontology) + concept_name and
// POSTs to /api/reviews/:p/:t/spans. Server faithfulness-checks the
// offsets against the note bytes before persisting.
function NewSpanPopover({
  patientId, taskId, noteId, selection, onClose, onCreated,
}: {
  patientId: string;
  taskId: string;
  noteId: string;
  selection: { start: number; end: number; text: string };
  onClose: () => void;
  onCreated: () => void;
}) {
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [entityType, setEntityType] = useState("");
  const [conceptName, setConceptName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Pull entity_types from the AUTHOR endpoint (returns the
    // ontology's entity_types as a side-effect of the task's
    // task_kind=ner guard).
    authFetch(`/api/tasks/${encodeURIComponent(taskId)}/entity-type-guidance`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: { entity_types?: string[] } | null) => {
        const types = d?.entity_types ?? [];
        setEntityTypes(types);
        if (types.length > 0) setEntityType(types[0]!);
      })
      .catch(() => undefined);
  }, [taskId]);

  async function submit() {
    if (!entityType) { setError("pick an entity_type"); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(
        withSession(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/spans`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            note_id: noteId,
            text: selection.text,
            anchor: selection.text,
            start: selection.start,
            end: selection.end,
            entity_type: entityType,
            concept_name: conceptName.trim(),
          }),
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as {
          error?: string;
          payload?: { error?: string };
        };
        setError(body.payload?.error ?? body.error ?? `create failed: ${r.status}`);
        return;
      }
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed right-6 bottom-6 z-50 w-96 rounded-md border-2 border-foreground/40 bg-card shadow-2xl p-4 space-y-2 text-[12px]">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-[13px]">+ New span</div>
        <Button variant="ghost" size="sm" onClick={onClose}><X className="size-3.5" /></Button>
      </div>
      <div className="text-[11px] space-y-0.5">
        <div className="text-muted-foreground">selection:</div>
        <div className="font-mono text-[11px] bg-muted/40 rounded px-1.5 py-0.5">
          [{selection.start},{selection.end}) {JSON.stringify(selection.text).slice(0, 80)}
        </div>
      </div>
      <div>
        <label className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">entity_type</label>
        <select
          className="mt-0.5 w-full px-2 py-1 border border-border rounded bg-background text-[11.5px]"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
        >
          {entityTypes.length === 0 && <option value="">(loading…)</option>}
          {entityTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <label className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
          concept_name
        </label>
        <input
          type="text"
          className="mt-0.5 w-full px-2 py-1 border border-border rounded bg-background text-[11.5px]"
          value={conceptName}
          onChange={(e) => setConceptName(e.target.value)}
          placeholder="e.g. Age"
        />
      </div>
      {error && <div className="text-[11px] text-[hsl(var(--oxblood))]">{error}</div>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button size="sm" onClick={submit} disabled={busy || !entityType}>
          <Check className="size-3.5" /> {busy ? "Saving…" : "Create"}
        </Button>
      </div>
    </div>
  );
}
