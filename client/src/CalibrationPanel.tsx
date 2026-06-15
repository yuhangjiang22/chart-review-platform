// app/client/src/CalibrationPanel.tsx
//
// Studio card for the κ calibration workflow (#21 trigger, #22 viewer).
// Replaces the curl-only access to POST /api/guideline-calibration/<tid>.

import { useEffect, useState } from "react";
import { authFetch } from "./auth";
import { Markdown } from "./markdown";

interface RunListing { run_id: string; archived_at: string }
interface RawCalibration {
  guideline_id: string;
  run_id: string;
  kappa_threshold: number;
  min_shared: number;
  total_criteria: number;
  criteria_calibrated: number;
  buckets: Record<string, number>;
  recommendation: "ready_to_lock" | "revise_then_recalibrate" | "insufficient_data";
  per_criterion: Array<{
    field_id: string;
    has_kappa: boolean;
    kappa?: number;
    n_shared?: number;
    bucket: string;
    note?: string;
  }>;
}

export function CalibrationPanel({ taskId, isMethodologist, onProposeImprovement }: {
  taskId: string | null;
  isMethodologist: boolean;
  onProposeImprovement?: (fieldId: string) => void;
}) {
  const [runs, setRuns] = useState<RunListing[]>([]);
  const [active, setActive] = useState<{ raw: RawCalibration; report_md: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [threshold, setThreshold] = useState(0.7);
  const [minShared, setMinShared] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [blinded, setBlinded] = useState(false);
  const [blindBusy, setBlindBusy] = useState(false);

  // Read maturity to surface current blinding state.
  useEffect(() => {
    if (!taskId) {
      setBlinded(false);
      return;
    }
    authFetch(`/api/guidelines/${taskId}/maturity`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => setBlinded(!!m?.calibration_blinded))
      .catch(() => setBlinded(false));
  }, [taskId]);

  async function toggleBlinding() {
    if (!taskId) return;
    setBlindBusy(true);
    try {
      const r = await authFetch(`/api/guidelines/${taskId}/blinding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blinded: !blinded }),
      });
      if (r.ok) {
        const body = await r.json();
        setBlinded(!!body.calibration_blinded);
      }
    } finally {
      setBlindBusy(false);
    }
  }

  function refreshRuns() {
    if (!taskId) return;
    authFetch(`/api/guideline-calibration/${taskId}/runs`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setRuns);
  }

  useEffect(() => {
    setActive(null);
    setError(null);
    refreshRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  async function loadRun(runId: string) {
    if (!taskId) return;
    setError(null);
    const r = await authFetch(`/api/guideline-calibration/${taskId}/runs/${runId}`);
    if (r.ok) setActive(await r.json());
    else setError(`Failed to load run ${runId}`);
  }

  async function runCalibration() {
    if (!taskId) return;
    setRunning(true);
    setError(null);
    try {
      const r = await authFetch(`/api/guideline-calibration/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kappa_threshold: threshold, min_shared: minShared }),
      });
      const body = await r.json();
      if (body.ok) {
        await loadRun(body.run_id);
        refreshRuns();
      } else {
        setError(body.error ?? "calibration failed");
      }
    } catch (e) {
      setError(String(e));
    }
    setRunning(false);
  }

  return (
    <section className="bg-card border border-border rounded p-4">
      <header className="mb-3">
        <h3 className="font-semibold text-foreground text-sm">🎯 Calibration (κ check)</h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Replays reviewer answers, computes Cohen's κ per criterion. Runs
          archived under <code>calibration/&lt;task&gt;/&lt;ts&gt;/</code>.
        </p>
      </header>

      {!taskId && <p className="text-[11px] text-muted-foreground/70">select a task</p>}

      {taskId && isMethodologist && (
        <div className="space-y-2 mb-3 text-[11px]">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">κ threshold</span>
              <input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={threshold}
                onChange={(e) => setThreshold(parseFloat(e.target.value) || 0)}
                className="w-full border border-border rounded px-2 py-1 mt-0.5"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">min n_shared</span>
              <input
                type="number"
                min={1}
                value={minShared}
                onChange={(e) => setMinShared(parseInt(e.target.value, 10) || 1)}
                className="w-full border border-border rounded px-2 py-1 mt-0.5"
              />
            </label>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={runCalibration}
              disabled={running}
              className="px-3 py-1 rounded bg-[hsl(var(--sage))] text-white text-xs hover:bg-[hsl(var(--sage)/0.85)] disabled:bg-secondary"
            >
              {running ? "running…" : "▶ run calibration"}
            </button>
            <button
              onClick={toggleBlinding}
              disabled={blindBusy}
              className={`px-3 py-1 rounded text-xs ${
                blinded
                  ? "bg-primary text-white hover:bg-primary/90"
                  : "bg-secondary text-foreground hover:bg-secondary"
              } disabled:opacity-50`}
              title={
                blinded
                  ? "Reviewers see only their own + agent assessments. Click to disable."
                  : "Enable to hide other reviewers' answers during calibration (per-task)."
              }
            >
              {blinded ? "🙈 blinding ON" : "👁 blinding off"}
            </button>
          </div>
        </div>
      )}

      {!isMethodologist && taskId && (
        <p className="text-[11px] text-muted-foreground/70 mb-3">
          read-only — methodologist privilege required to run
        </p>
      )}

      {error && <pre className="text-[10px] text-[hsl(var(--oxblood))] whitespace-pre-wrap mb-2">{error}</pre>}

      {runs.length > 0 && (
        <details className="mb-3 border border-border rounded">
          <summary className="px-2 py-1 cursor-pointer text-[11px] text-foreground font-semibold">
            run history ({runs.length})
          </summary>
          <ul className="divide-y divide-border">
            {runs.map((r) => (
              <li key={r.run_id} className="flex items-center justify-between px-2 py-1 text-[10.5px]">
                <button onClick={() => loadRun(r.run_id)} className="font-mono text-teal-700 hover:underline truncate">
                  {r.run_id}
                </button>
                <span className="text-muted-foreground whitespace-nowrap ml-2">{r.archived_at.slice(0, 19)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {active && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Recommendation r={active.raw.recommendation} />
            <span className="text-[10px] text-muted-foreground">
              {active.raw.criteria_calibrated}/{active.raw.total_criteria} criteria calibrated · κ ≥ {active.raw.kappa_threshold} · n ≥ {active.raw.min_shared}
            </span>
          </div>
          <div className="grid grid-cols-5 gap-1 text-[10px]">
            {(["excellent", "acceptable", "weak", "poor", "low_n"] as const).map((b) => (
              <div key={b} className="border border-border rounded px-2 py-1 text-center">
                <div className="font-semibold text-foreground">{active.raw.buckets[b] ?? 0}</div>
                <div className="text-muted-foreground">{b}</div>
              </div>
            ))}
          </div>

          <details className="border border-border rounded">
            <summary className="px-2 py-1 cursor-pointer text-[11px] text-foreground font-semibold">
              per-criterion ({active.raw.per_criterion.length})
            </summary>
            <ul className="divide-y divide-border text-[10.5px]">
              {active.raw.per_criterion.map((c) => (
                <li key={c.field_id} className="flex items-center justify-between px-2 py-1 gap-2">
                  <code className="text-foreground truncate">{c.field_id}</code>
                  <div className="flex items-center gap-1 whitespace-nowrap">
                    <BucketPill b={c.bucket} />
                    <span className="text-muted-foreground">
                      {c.has_kappa ? `κ=${c.kappa?.toFixed(3)} (n=${c.n_shared})` : c.note ?? "—"}
                    </span>
                    {(c.bucket === "weak" || c.bucket === "poor") && onProposeImprovement && (
                      <button
                        onClick={() => onProposeImprovement(c.field_id)}
                        className="ml-1 px-1.5 py-0.5 rounded bg-[hsl(var(--ochre))] text-white text-[9.5px] hover:bg-[hsl(var(--ochre))]"
                        title="Pre-fill an InlineProposeRuleModal for this field's κ failure"
                      >
                        propose fix
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </details>

          {active.report_md && (
            <details className="border border-border rounded">
              <summary className="px-2 py-1 cursor-pointer text-[11px] text-foreground font-semibold">
                full report (markdown)
              </summary>
              <div className="p-2 text-[11.5px]">
                <Markdown source={active.report_md} />
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function Recommendation({ r }: { r: RawCalibration["recommendation"] }) {
  const cls =
    r === "ready_to_lock"
      ? "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]"
      : r === "revise_then_recalibrate"
        ? "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]"
        : "bg-secondary text-foreground";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{r.replace(/_/g, " ")}</span>;
}

function BucketPill({ b }: { b: string }) {
  const cls =
    b === "excellent" ? "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]" :
    b === "acceptable" ? "bg-teal-100 text-teal-700" :
    b === "weak" ? "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]" :
    b === "poor" ? "bg-[hsl(var(--oxblood)/0.15)] text-[hsl(var(--oxblood))]" :
    "bg-secondary text-muted-foreground";
  return <span className={`text-[9.5px] px-1.5 py-0.5 rounded ${cls}`}>{b}</span>;
}
