import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  // Export the validated task package (rubric + agent config + performance +
  // gold answers) to var/exports/ so it can be re-run on a larger cohort.
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<
    { dir: string; n_gold_patients: number } | { error: string } | null
  >(null);

  async function exportPackage() {
    setExporting(true);
    setExportResult(null);
    try {
      const qs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";
      const r = await authFetch(`/api/export/${encodeURIComponent(taskId)}${qs}`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body?.ok) {
        setExportResult({ dir: body.dir, n_gold_patients: body.n_gold_patients });
      } else {
        setExportResult({ error: body?.error ?? `HTTP ${r.status}` });
      }
    } catch (e) {
      setExportResult({ error: (e as Error).message });
    } finally {
      setExporting(false);
    }
  }

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

      {/* Export the validated task package for running on a larger cohort. */}
      <div className="border-t border-border/60 pt-5 space-y-2">
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={exportPackage} disabled={exporting}>
            <Download size={13} strokeWidth={1.75} />
            {exporting ? "Exporting…" : "Export task package"}
          </Button>
          <span className="text-[11.5px] text-muted-foreground">
            Saves the rubric, agent config, this session's performance, and your
            validated gold answers — to re-run on a larger cohort.
          </span>
        </div>
        {exportResult && "dir" in exportResult && (
          <div className="text-[12px] text-[hsl(var(--sage))]">
            Saved to <span className="font-mono">{exportResult.dir}</span> ·{" "}
            {exportResult.n_gold_patients} gold patient
            {exportResult.n_gold_patients === 1 ? "" : "s"}.
          </div>
        )}
        {exportResult && "error" in exportResult && (
          <div className="text-[12px] text-destructive">Export failed: {exportResult.error}</div>
        )}
      </div>
    </div>
  );
}
