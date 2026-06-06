import { useEffect, useState } from "react";
import { authFetch } from "../../auth";

// Performance report (light platform DECIDE phase).
//
// Shows per-field agent-vs-human accuracy across every patient that has a
// validated review_state for this task. Data comes from
// GET /api/performance/:taskId (which reuses computeIterAccuracy). This is
// the terminal phase: run → validate → performance. No iterate/lock loop.

interface PerCriterion {
  field_id: string;
  n_evaluable: number;
  n_correct: number;
  accuracy: number | null;
}

interface PerformanceReport {
  task_id: string;
  n_patients: number;
  per_criterion: PerCriterion[];
  avg_accuracy: number | null;
  override_count: number;
  computed_at: string;
}

export interface PhaseDecideProps {
  taskId: string;
}

function pct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(0)}%`;
}

export function PhaseDecide({ taskId }: PhaseDecideProps) {
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    authFetch(`/api/performance/${encodeURIComponent(taskId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: PerformanceReport) => {
        if (cancelled) return;
        setReport(d);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Performance</h2>
        <p className="text-[12.5px] text-muted-foreground">
          How the agent's answers compared to your validated answers, per field.
        </p>
      </div>

      {state === "loading" && (
        <div className="text-[13px] text-muted-foreground">Computing performance…</div>
      )}

      {state === "error" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-[12.5px] text-destructive">
          Could not load the performance report.
        </div>
      )}

      {state === "ready" && report && report.n_patients === 0 && (
        <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-[12.5px] text-muted-foreground">
          No validated patients yet. Run the agent (TRY) and validate at least one
          patient (VALIDATE) to see performance.
        </div>
      )}

      {state === "ready" && report && report.n_patients > 0 && (
        <div className="space-y-4">
          <div className="text-[12.5px] text-muted-foreground">
            Across <strong>{report.n_patients}</strong> validated patient
            {report.n_patients === 1 ? "" : "s"} · {report.override_count} override
            {report.override_count === 1 ? "" : "s"}
          </div>

          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Field</th>
                <th className="py-2 pr-4 font-medium">Agreement</th>
                <th className="py-2 pr-4 font-medium">Correct / evaluable</th>
              </tr>
            </thead>
            <tbody>
              {report.per_criterion.map((c) => (
                <tr key={c.field_id} className="border-b border-border/30">
                  <td className="py-2 pr-4 font-mono text-[12px]">{c.field_id}</td>
                  <td className="py-2 pr-4 tabular-nums">{pct(c.accuracy)}</td>
                  <td className="py-2 pr-4 tabular-nums text-muted-foreground">
                    {c.n_correct} / {c.n_evaluable}
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-2 pr-4">Overall (avg)</td>
                <td className="py-2 pr-4 tabular-nums">{pct(report.avg_accuracy)}</td>
                <td className="py-2 pr-4" />
              </tr>
            </tbody>
          </table>

          <p className="text-[11px] text-muted-foreground">
            Agreement = fraction of validated patients where the agent's answer matched
            your final answer for that field.
          </p>
        </div>
      )}
    </div>
  );
}
