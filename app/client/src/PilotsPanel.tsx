// app/client/src/PilotsPanel.tsx
//
// Studio card for pilot iterations (#11). A pilot iteration is a tagged
// batch run with extra lifecycle state (running → ready_to_validate →
// complete | abandoned). Clicking an iteration drills through to the
// existing RunDetailModal (#10) since the actual agent drafts live in
// runs/<run_id>/per_patient/.

import { useEffect, useState } from "react";
import { authFetch } from "./auth";
import { MaturityBadge, useMaturity } from "./MaturityPanel";

interface PilotStats {
  iter_id: string;
  iter_num: number;
  guideline_sha: string;
  state: string;
  n_patients: number;
  n_complete: number;
  n_imported: number;
  n_overrides: number;
  override_rate: number;
  proposal_count: number;
  total_cost_usd: number;
}

interface PilotListing {
  task_id: string;
  iter_id: string;
  iter_num: number;
  run_id: string;
  guideline_sha: string;
  started_at: string;
  started_by: string;
  state: "running" | "ready_to_validate" | "complete" | "abandoned";
  notes?: string;
  completed_at?: string;
  run_status: "running" | "complete" | "complete_with_errors" | "aborted_cost_cap" | "failed" | null;
  n_complete: number;
  n_patients: number;
  critique?: { ran_at: string; proposal_count: number; error?: string } | null;
  /** #42 — set when the server auto-fires self-critique on state→complete. */
  auto_critique_state?: "running" | "failed";
}

export function PilotsPanel({ taskId, isMethodologist, onOpenRun }: {
  taskId: string | null;
  isMethodologist: boolean;
  onOpenRun: (runId: string) => void;
}) {
  const [pilots, setPilots] = useState<PilotListing[]>([]);
  const [showStart, setShowStart] = useState(false);
  const [busyIter, setBusyIter] = useState<string | null>(null);
  const [critiqueIter, setCritiqueIter] = useState<string | null>(null);
  const [stats, setStats] = useState<PilotStats[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const { record: maturity } = useMaturity(taskId);

  function refresh() {
    if (!taskId) {
      setPilots([]);
      setStats([]);
      return;
    }
    authFetch(`/api/pilots/${taskId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setPilots)
      .catch(() => setPilots([]));
    authFetch(`/api/pilots/${taskId}/stats`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setStats)
      .catch(() => setStats([]));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // #42 — while any pilot has auto_critique_state="running", poll every 5 s
  // so the result badge updates as soon as the background critique finishes.
  // Stops as soon as no auto-critique is in flight.
  useEffect(() => {
    const anyRunning = pilots.some((p) => p.auto_critique_state === "running");
    if (!anyRunning) return;
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pilots]);

  async function setState(iterId: string, newState: PilotListing["state"]) {
    if (!taskId) return;
    setBusyIter(iterId);
    try {
      const r = await authFetch(`/api/pilots/${taskId}/${iterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: newState }),
      });
      if (r.ok) refresh();
    } finally {
      setBusyIter(null);
    }
  }

  async function runCritique(iterId: string) {
    if (!taskId) return;
    setCritiqueIter(iterId);
    try {
      const r = await authFetch(`/api/pilots/${taskId}/${iterId}/critique`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await r.json();
      if (body.error && !body.proposal_count) {
        alert(`Self-critique: ${body.error}`);
      } else {
        alert(
          `Self-critique generated ${body.proposal_count} proposal${body.proposal_count === 1 ? "" : "s"}.\n\n` +
          `Review them in the Rules panel of the methodologist surface.`,
        );
      }
      refresh();
    } catch (e) {
      alert(`Self-critique failed: ${e}`);
    } finally {
      setCritiqueIter(null);
    }
  }

  return (
    <section className="bg-card border border-border rounded p-4">
      <header className="mb-3">
        <h3 className="font-semibold text-foreground text-sm flex items-center gap-2">
          🧪 Pilot iterations
          {maturity && <MaturityBadge state={maturity.state} compact />}
        </h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Iterate on a draft guideline against a small sample. Each
          iteration is a tagged batch run plus methodologist notes.
          Stored at <code>guidelines/&lt;task&gt;/pilots/iter_NNN/</code>.
        </p>
      </header>

      {!taskId && (
        <p className="text-[11px] text-muted-foreground/70">select a task to see its pilot iterations</p>
      )}

      {taskId && isMethodologist && (
        <button
          onClick={() => setShowStart(true)}
          className="px-3 py-1 rounded bg-violet-600 text-white text-xs hover:bg-violet-700 mb-3"
        >
          ▶ start new iteration
        </button>
      )}

      {taskId && !isMethodologist && (
        <p className="text-[11px] text-muted-foreground/70 mb-3">
          read-only — methodologist privilege required to start an iteration
        </p>
      )}

      {taskId && stats.length >= 2 && (
        <button
          onClick={() => setShowCompare((v) => !v)}
          className="mb-2 px-2 py-0.5 rounded bg-muted text-foreground text-[10.5px] hover:bg-secondary"
        >
          {showCompare ? "hide compare" : "📊 compare iterations"}
        </button>
      )}

      {taskId && showCompare && stats.length >= 2 && (
        <div className="mb-3 border border-border rounded p-2 overflow-x-auto">
          <table className="text-[10.5px] w-full border-collapse">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left px-1 py-0.5">iter</th>
                <th className="text-left px-1 py-0.5">SHA</th>
                <th className="text-right px-1 py-0.5">complete</th>
                <th className="text-right px-1 py-0.5">imported</th>
                <th className="text-right px-1 py-0.5">overrides</th>
                <th className="text-right px-1 py-0.5">override rate</th>
                <th className="text-right px-1 py-0.5">proposals</th>
                <th className="text-right px-1 py-0.5">cost</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s, i) => {
                const prev = i > 0 ? stats[i - 1] : null;
                const delta = (cur: number, p: number | undefined) =>
                  p === undefined ? null : cur - p;
                const fmtDelta = (d: number | null, asPct = false): string => {
                  if (d === null) return "";
                  const sign = d > 0 ? "+" : "";
                  return ` (${sign}${asPct ? (d * 100).toFixed(1) + "pp" : d.toFixed(2)})`;
                };
                const dOR = delta(s.override_rate, prev?.override_rate);
                const dProp = delta(s.proposal_count, prev?.proposal_count);
                return (
                  <tr key={s.iter_id} className="border-t border-border/50 font-mono">
                    <td className="px-1 py-0.5 text-violet-700">{s.iter_id}</td>
                    <td className="px-1 py-0.5 text-muted-foreground">{s.guideline_sha.slice(0, 8)}</td>
                    <td className="px-1 py-0.5 text-right">{s.n_complete}/{s.n_patients}</td>
                    <td className="px-1 py-0.5 text-right">{s.n_imported}</td>
                    <td className="px-1 py-0.5 text-right">{s.n_overrides}</td>
                    <td className={`px-1 py-0.5 text-right ${dOR != null && dOR < 0 ? "text-[hsl(var(--sage))]" : dOR != null && dOR > 0 ? "text-[hsl(var(--oxblood))]" : ""}`}>
                      {(s.override_rate * 100).toFixed(1)}%
                      <span className="text-muted-foreground/70">{fmtDelta(dOR, true)}</span>
                    </td>
                    <td className={`px-1 py-0.5 text-right ${dProp != null && dProp < 0 ? "text-[hsl(var(--sage))]" : dProp != null && dProp > 0 ? "text-[hsl(var(--oxblood))]" : ""}`}>
                      {s.proposal_count}
                      <span className="text-muted-foreground/70">{fmtDelta(dProp)}</span>
                    </td>
                    <td className="px-1 py-0.5 text-right text-muted-foreground">${s.total_cost_usd.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-[9.5px] text-muted-foreground mt-1">
            Lower override rate + lower proposal count over iterations indicates the guideline is stabilizing.
          </p>
        </div>
      )}

      {taskId && pilots.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/70">no iterations yet</p>
      ) : (
        <ul className="space-y-2 text-[11px]">
          {pilots.map((p) => (
            <li key={p.iter_id} className="border border-border rounded p-2">
              <div className="flex items-center justify-between gap-2 mb-1">
                <button
                  onClick={() => onOpenRun(p.run_id)}
                  className="font-mono text-violet-700 hover:underline"
                >
                  {p.iter_id}
                </button>
                <PilotStatePill state={p.state} />
              </div>
              <div className="text-[10px] text-muted-foreground">
                SHA <code>{p.guideline_sha.slice(0, 8)}</code> ·{" "}
                {p.n_complete}/{p.n_patients} drafted
                {p.run_status && ` · run: ${p.run_status.replace(/_/g, " ")}`}
                {" · "}
                {p.started_at.slice(0, 19)}
                {" · "}
                {p.started_by}
              </div>
              {p.notes && (
                <div className="text-[10.5px] text-foreground mt-1 italic">
                  {p.notes}
                </div>
              )}
              {p.auto_critique_state === "running" && !p.critique && (
                <div className="text-[10px] mt-1 text-[hsl(var(--ochre))] italic inline-flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-500 animate-pulse" />
                  🤖 auto-critiquing… (clustering reviewer overrides into proposals)
                </div>
              )}
              {p.auto_critique_state === "failed" && !p.critique && (
                <div className="text-[10px] mt-1 text-[hsl(var(--oxblood))]">
                  auto-critique failed — click 🤖 self-critique to retry
                </div>
              )}
              {p.critique && (
                <div className="text-[10px] mt-1">
                  {p.critique.error ? (
                    <span className="text-[hsl(var(--oxblood))]">critique error: {p.critique.error}</span>
                  ) : (
                    <span className="text-[hsl(var(--sage))]">
                      🤖 self-critique → {p.critique.proposal_count} proposal{p.critique.proposal_count === 1 ? "" : "s"}
                      {" · "}
                      {p.critique.ran_at.slice(0, 19)}
                    </span>
                  )}
                </div>
              )}
              {isMethodologist && p.state !== "abandoned" && (
                <div className="flex gap-1 mt-1 flex-wrap">
                  {p.run_status &&
                    p.run_status !== "running" &&
                    p.state === "running" && (
                      <button
                        onClick={() => setState(p.iter_id, "ready_to_validate")}
                        disabled={busyIter === p.iter_id}
                        className="px-2 py-0.5 rounded bg-[hsl(var(--ochre))] text-white text-[10px] hover:bg-[hsl(var(--ochre))] disabled:bg-secondary"
                      >
                        mark ready to validate
                      </button>
                    )}
                  {p.run_status && p.run_status !== "running" && p.auto_critique_state !== "running" && (
                    <button
                      onClick={() => runCritique(p.iter_id)}
                      disabled={critiqueIter === p.iter_id}
                      className="px-2 py-0.5 rounded bg-primary text-white text-[10px] hover:bg-primary/90 disabled:bg-secondary"
                      title="Cluster reviewer overrides on imported drafts and propose guideline edits. Auto-fires when you mark this pilot complete."
                    >
                      {critiqueIter === p.iter_id
                        ? "critiquing…"
                        : p.critique
                          ? "🤖 re-run self-critique"
                          : "🤖 self-critique"}
                    </button>
                  )}
                  {p.state !== "complete" && (
                    <button
                      onClick={() => setState(p.iter_id, "complete")}
                      disabled={busyIter === p.iter_id}
                      className="px-2 py-0.5 rounded bg-[hsl(var(--sage))] text-white text-[10px] hover:bg-[hsl(var(--sage))] disabled:bg-secondary"
                    >
                      mark complete
                    </button>
                  )}
                  {p.state !== "complete" && (
                    <button
                      onClick={() => setState(p.iter_id, "abandoned")}
                      disabled={busyIter === p.iter_id}
                      className="px-2 py-0.5 rounded bg-secondary text-foreground text-[10px] hover:bg-slate-400 disabled:opacity-50"
                    >
                      abandon
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {showStart && taskId && (
        <StartPilotModal
          taskId={taskId}
          onClose={(started) => {
            setShowStart(false);
            if (started) refresh();
          }}
        />
      )}
    </section>
  );
}

function PilotStatePill({ state }: { state: PilotListing["state"] }) {
  const cls = state === "complete"
    ? "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]"
    : state === "ready_to_validate"
      ? "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]"
      : state === "abandoned"
        ? "bg-secondary text-muted-foreground"
        : "bg-violet-100 text-violet-700";
  return <span className={`text-[9px] px-1.5 py-0.5 rounded ${cls}`}>{state.replace(/_/g, " ")}</span>;
}

function StartPilotModal({ taskId, onClose }: { taskId: string; onClose: (started: boolean) => void }) {
  const [patientIdsRaw, setPatientIdsRaw] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const patient_ids = patientIdsRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (patient_ids.length === 0) {
      setError("at least one patient_id required");
      setBusy(false);
      return;
    }
    try {
      const r = await authFetch(`/api/pilots/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_ids,
          notes: notes || undefined,
        }),
      });
      const body = await r.json();
      if (body.pilot) onClose(true);
      else setError(body.error ?? "failed to start pilot");
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => onClose(false)}
    >
      <div
        className="bg-card rounded-xl border border-border shadow-2xl w-[520px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-3 border-b border-border flex items-center justify-between">
          <div className="text-[14px] font-semibold">▶ Start a pilot iteration on {taskId}</div>
          <button onClick={() => onClose(false)} className="text-muted-foreground hover:text-foreground">×</button>
        </header>
        <div className="p-4 space-y-3 text-[12px]">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              patient_ids (comma or whitespace separated)
            </span>
            <textarea
              value={patientIdsRaw}
              onChange={(e) => setPatientIdsRaw(e.target.value)}
              rows={4}
              className="w-full border border-border rounded px-2 py-1 mt-0.5 text-[11.5px] font-mono"
              placeholder="pt_001 pt_007 pt_023"
            />
          </label>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="What are you testing in this iteration?"
              className="w-full border border-border rounded px-2 py-1 mt-0.5 text-[11.5px]"
            />
          </label>

          {error && <div className="text-[hsl(var(--oxblood))] text-[11px]">{error}</div>}

          <div className="pt-2 flex justify-end gap-2">
            <button
              onClick={() => onClose(false)}
              className="px-3 py-1 rounded bg-muted text-foreground text-xs hover:bg-secondary"
            >
              cancel
            </button>
            <button
              onClick={start}
              disabled={busy || !patientIdsRaw.trim()}
              className="px-3 py-1 rounded bg-violet-600 text-white text-xs hover:bg-violet-700 disabled:bg-secondary"
            >
              {busy ? "starting…" : "start"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
