// Collapsible visualization of a bso-ad-ner-sdk run's per-note agent trace
// (var/benchmark-sdk/<session>/<note_id>_events.jsonl). Read-only.
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../auth";

interface Ev { event: string; turn?: number; tool_name?: string; input_preview?: string;
  model?: string; max_turns?: number; max_budget_usd?: number; prior_runs?: number;
  turns?: number; duration_ms?: number; cost_usd_estimated?: number; is_error?: boolean;
  usage?: Record<string, number>; }

export function AgentTracePanel({ sessionId }: { sessionId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/ner-sdk/events?session_id=${encodeURIComponent(sessionId)}`);
        if (!r.ok) { if (!cancelled) setError(`Events load failed: ${r.status}`); return; }
        const { notes } = (await r.json()) as { notes: string[] };
        if (cancelled) return;
        setNotes(notes);
        if (notes.length && !noteId) setNoteId(notes[0]);
      } catch (e) { if (!cancelled) setError(String(e)); }
    })();
    return () => { cancelled = true; };
  }, [open, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadNote = useCallback(async () => {
    if (!sessionId || !noteId) return;
    try {
      const r = await authFetch(`/api/ner-sdk/events?session_id=${encodeURIComponent(sessionId)}&note_id=${encodeURIComponent(noteId)}`);
      if (r.ok) setEvents(((await r.json()) as { events: Ev[] }).events);
    } catch { /* keep */ }
  }, [sessionId, noteId]);
  useEffect(() => { void loadNote(); }, [loadNote]);

  const start = events.find((e) => e.event === "run_start");
  const end = events.find((e) => e.event === "run_end");
  const calls = events.filter((e) => e.event === "tool_call");

  return (
    <div className="rounded-md border border-border bg-paper/40 px-4 py-3">
      <button className="flex w-full items-center justify-between text-[10px] uppercase tracking-[0.14em] text-muted-foreground" onClick={() => setOpen((v) => !v)}>
        <span>Agent trace {notes.length ? `(${notes.length} notes)` : ""}</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-[12px]">
          {error && <div className="text-red-600">{error}</div>}
          {!notes.length && !error && <div className="text-muted-foreground">No agent runs yet.</div>}
          {notes.length > 0 && (
            <select className="rounded border border-border bg-paper px-2 py-1 font-mono text-[12px]"
              value={noteId ?? ""} onChange={(e) => setNoteId(e.target.value)}>
              {notes.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          {start && (
            <div className="text-[11px] text-muted-foreground">
              model {start.model} · max_turns {start.max_turns} · budget ${start.max_budget_usd} · prior_runs {start.prior_runs ?? 0}
            </div>
          )}
          {calls.length > 0 && (
            <div className="max-h-[46vh] overflow-y-auto rounded border border-border divide-y divide-border">
              {calls.map((c, i) => (
                <div key={i} className="px-2 py-1 font-mono text-[11.5px]">
                  <span className="text-muted-foreground">t{c.turn}</span>{" "}
                  <span className="text-ink">{c.tool_name}</span>
                  {c.input_preview && <span className="text-muted-foreground"> — {c.input_preview}</span>}
                </div>
              ))}
            </div>
          )}
          {end && (
            <div className={`text-[11px] ${end.is_error ? "text-red-600" : "text-muted-foreground"}`}>
              {end.is_error ? "errored · " : "done · "}{end.turns} turns · {Math.round((end.duration_ms ?? 0) / 1000)}s · ${(end.cost_usd_estimated ?? 0).toFixed(3)}
              {end.usage?.output_tokens != null ? ` · ${end.usage.output_tokens} out-tok` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
