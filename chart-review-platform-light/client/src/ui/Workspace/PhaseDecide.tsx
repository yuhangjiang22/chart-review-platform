import { useEffect, useState } from "react";
import { authFetch } from "../../auth";

// Performance report (light platform DECIDE phase).
//
// Per-agent agent-vs-human accuracy across the patients you've validated.
// Data: GET /api/performance/:taskId. Each agent's run draft is compared to
// your validated answers, so a default-vs-skeptical run shows both agents.

interface PerField {
  field_id: string;
  n_evaluable: number;
  n_correct: number;
  accuracy: number | null;
}
interface AgentPerf {
  agent_id: string;
  per_field: PerField[];
  avg_accuracy: number | null;
}
interface PerformanceReport {
  task_id: string;
  n_patients: number;
  field_ids: string[];
  agents: AgentPerf[];
}

function pct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(0)}%`;
}

export interface PhaseDecideProps {
  taskId: string;
  /** Scope the report to this session's runs. Without it the report would
   *  aggregate every validated patient for the task across all sessions. */
  activeSessionId?: string | null;
}

export function PhaseDecide({ taskId, activeSessionId }: PhaseDecideProps) {
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    const qs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";
    authFetch(`/api/performance/${encodeURIComponent(taskId)}${qs}`)
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
  }, [taskId, activeSessionId]);

  const hasData = !!report && report.n_patients > 0 && report.agents.length > 0;

  // field_id -> agent_id -> PerField, for matrix lookup
  const cell = (agent: AgentPerf, fid: string) =>
    agent.per_field.find((c) => c.field_id === fid);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Performance</h2>
        <p className="text-[12.5px] text-muted-foreground">
          How each agent's answers compared to your validated answers, per field.
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
          No validated patients yet. Run the agents (TRY), validate at least one
          patient and mark it validated (VALIDATE) to see performance.
        </div>
      )}

      {state === "ready" && hasData && report && (
        <div className="space-y-4">
          <div className="text-[12.5px] text-muted-foreground">
            Across <strong>{report.n_patients}</strong> validated patient
            {report.n_patients === 1 ? "" : "s"} · {report.agents.length} agent
            {report.agents.length === 1 ? "" : "s"}
          </div>

          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Field</th>
                {report.agents.map((a) => (
                  <th key={a.agent_id} className="py-2 pr-4 font-medium font-mono text-[12px]">
                    {a.agent_id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.field_ids.map((fid) => (
                <tr key={fid} className="border-b border-border/30">
                  <td className="py-2 pr-4 font-mono text-[12px]">{fid}</td>
                  {report.agents.map((a) => {
                    const c = cell(a, fid);
                    return (
                      <td key={a.agent_id} className="py-2 pr-4 tabular-nums">
                        {pct(c?.accuracy ?? null)}
                        <span className="ml-1.5 text-[11px] text-muted-foreground">
                          ({c?.n_correct ?? 0}/{c?.n_evaluable ?? 0})
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-2 pr-4">Overall (avg)</td>
                {report.agents.map((a) => (
                  <td key={a.agent_id} className="py-2 pr-4 tabular-nums">
                    {pct(a.avg_accuracy)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>

          <p className="text-[11px] text-muted-foreground">
            Agreement = fraction of validated patients where that agent's answer
            matched your final answer for the field.
          </p>
        </div>
      )}
    </div>
  );
}
