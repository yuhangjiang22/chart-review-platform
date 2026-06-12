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

// ── NER performance shapes (GET /api/calibrate-ner/:taskId) ──────────────────
// Per-agent span-IAA against the reviewer's validated spans. Mirrors the
// server route's response (server/ner-calibration-routes.ts).
interface NerPerEntityType {
  entity_type: string;
  agree: number;
  soft_or_boundary: number;
  miss_only_a: number;
  miss_only_b: number;
  precision: number;
  recall: number;
  f1: number;
}
interface NerAgentReport {
  agent_id: string;
  macro_f1?: number | null;
  tuple_kappa?: number | null;
  per_entity_type: NerPerEntityType[];
  n_spans: number;
}
interface NerCalibrationReport {
  ok: boolean;
  task_id: string;
  n_patients: number;
  n_validated_notes: number;
  n_reviewer_spans: number;
  agents: NerAgentReport[];
}

function pct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(0)}%`;
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(2);
}

export interface PhaseDecideProps {
  taskId: string;
  /** Scope the report to this session's runs. Without it the report would
   *  aggregate every validated patient for the task across all sessions. */
  activeSessionId?: string | null;
  /** Score a specific iteration's run (the run-tab selection). Absent → the
   *  session's latest run. */
  iterId?: string | null;
  /** Task kind. NER tasks score spans (per-entity-type F1 + tuple-κ) via
   *  /api/calibrate-ner; everything else uses the phenotype field×agent
   *  matrix from /api/performance. The shared workspace `taskKind` always
   *  resolves to "phenotype" in this fork, so the caller branches on the
   *  raw task_type and threads "ner" here (same as PhaseJudge). */
  taskKind?: "phenotype" | "ner";
}

export function PhaseDecide({ taskId, activeSessionId, iterId, taskKind }: PhaseDecideProps) {
  const isNer = taskKind === "ner";
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [nerReport, setNerReport] = useState<NerCalibrationReport | null>(null);
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

    if (isNer) {
      // NER tasks score spans against the reviewer-validated ground truth.
      // session_id is required by the route (loud-fail 400 without it).
      const qs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";
      authFetch(`/api/calibrate-ner/${encodeURIComponent(taskId)}${qs}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: NerCalibrationReport) => {
          if (cancelled) return;
          setNerReport(d);
          setState("ready");
        })
        .catch(() => {
          if (!cancelled) setState("error");
        });
      return () => {
        cancelled = true;
      };
    }

    const params = new URLSearchParams();
    if (activeSessionId) params.set("session_id", activeSessionId);
    if (iterId) params.set("iter_id", iterId);
    const qs = params.toString() ? `?${params.toString()}` : "";
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
  }, [taskId, activeSessionId, iterId, isNer]);

  const hasData = !!report && report.n_patients > 0 && report.agents.length > 0;
  const nerHasData = !!nerReport && nerReport.n_validated_notes > 0 && nerReport.agents.length > 0;

  // field_id -> agent_id -> PerField, for matrix lookup
  const cell = (agent: AgentPerf, fid: string) =>
    agent.per_field.find((c) => c.field_id === fid);

  return (
    <div className="space-y-6">
      {/* Session-level export (NOT per-run): the package is session-scoped —
          it freezes this session's rubric + agent + validated gold so the CLI
          deploy runs exactly what was validated. */}
      <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2">
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={exportPackage} disabled={exporting}>
            <Download size={13} strokeWidth={1.75} />
            {exporting ? "Exporting…" : "Export session package"}
          </Button>
          <span className="text-[11.5px] text-muted-foreground">
            Freezes this session's rubric + agent config + your validated gold,
            so the CLI deploy runs exactly what you validated.
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

      <div>
        <h2 className="text-lg font-semibold">Performance</h2>
        <p className="text-[12.5px] text-muted-foreground">
          {isNer
            ? "F1 between each agent's drafted spans and your validated spans, scoped to notes you marked validated, per entity type."
            : "How each agent's answers compared to your validated answers, per field."}
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

      {/* ── NER performance: per-agent macro F1 + tuple-κ + per-entity-type ── */}
      {isNer && state === "ready" && !nerHasData && (
        <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-[12.5px] text-muted-foreground">
          No validated patients yet. Run the agents (TRY), validate at least one
          note and mark it validated (VALIDATE) to see performance.
        </div>
      )}

      {isNer && state === "ready" && nerHasData && nerReport && (
        <div className="space-y-4">
          <div className="text-[12.5px] text-muted-foreground">
            Across <strong>{nerReport.n_validated_notes}</strong> validated note
            {nerReport.n_validated_notes === 1 ? "" : "s"} in{" "}
            <strong>{nerReport.n_patients}</strong> patient
            {nerReport.n_patients === 1 ? "" : "s"} · {nerReport.n_reviewer_spans}{" "}
            reviewer span{nerReport.n_reviewer_spans === 1 ? "" : "s"} (ground truth) ·{" "}
            {nerReport.agents.length} agent{nerReport.agents.length === 1 ? "" : "s"}
          </div>

          {nerReport.agents.map((a) => (
            <div key={a.agent_id} className="rounded-md border border-border bg-card">
              <div className="px-4 py-3 flex items-baseline gap-3 border-b border-border/60">
                <span className="font-mono text-[12.5px]">{a.agent_id}</span>
                <span className="text-[11px] text-muted-foreground">
                  {a.n_spans} span{a.n_spans === 1 ? "" : "s"} in validated notes
                </span>
                <div className="ml-auto flex items-baseline gap-4">
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Macro F1
                    </div>
                    <div className="text-[20px] font-semibold tabular-nums">
                      {fmtNum(a.macro_f1)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Tuple κ
                    </div>
                    <div className="text-[20px] font-semibold tabular-nums">
                      {fmtNum(a.tuple_kappa)}
                    </div>
                  </div>
                </div>
              </div>
              {a.per_entity_type.length > 0 && (
                <table className="w-full text-[11.5px]">
                  <thead className="bg-muted/30 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-1.5">entity_type</th>
                      <th className="text-right px-2 py-1.5">precision</th>
                      <th className="text-right px-2 py-1.5">recall</th>
                      <th className="text-right px-2 py-1.5">F1</th>
                      <th className="text-right px-2 py-1.5">agree</th>
                      <th className="text-right px-2 py-1.5">agent-only</th>
                      <th className="text-right px-4 py-1.5">reviewer-only</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.per_entity_type.map((m) => (
                      <tr key={m.entity_type} className="border-t border-border/40">
                        <td className="px-4 py-1.5 font-mono text-[11px]">{m.entity_type}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(m.precision)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(m.recall)}</td>
                        <td className="px-2 py-1.5 text-right font-medium tabular-nums">{fmtNum(m.f1)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{m.agree}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{m.miss_only_a}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{m.miss_only_b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

          <p className="text-[11px] text-muted-foreground">
            F1 is computed against your validated spans (tuple-level). agent-only =
            spans the agent proposed that you didn't; reviewer-only = validated
            spans the agent missed.
          </p>
        </div>
      )}

      {!isNer && state === "ready" && report && report.n_patients === 0 && (
        <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-[12.5px] text-muted-foreground">
          No validated patients yet. Run the agents (TRY), validate at least one
          patient and mark it validated (VALIDATE) to see performance.
        </div>
      )}

      {!isNer && state === "ready" && hasData && report && (
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
