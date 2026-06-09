// NER calibration view — compares each agent's draft against the
// reviewer-validated spans (within validated_notes) and shows per-
// entity-type F1 + macro F1 + the headline tuple-κ as the "two raters
// agree?" number for publication. Replaces the phenotype-shaped
// CalibrationFigure on the LOCK page when task_kind=ner.

import { useState, useEffect } from "react";
import { authFetch } from "../../auth";
import { withSession } from "../../active-session";

interface PerEntityType {
  entity_type: string;
  agree: number;
  soft_or_boundary: number;
  miss_only_a: number;
  miss_only_b: number;
  precision: number;
  recall: number;
  f1: number;
}

interface AgentReport {
  agent_id: string;
  macro_f1?: number | null;
  tuple_kappa?: number | null;
  per_entity_type: PerEntityType[];
  n_spans: number;
}

interface CalibrationResponse {
  ok: boolean;
  task_id: string;
  n_patients: number;
  n_validated_notes: number;
  n_reviewer_spans: number;
  agents: AgentReport[];
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(2);
}

export function NerCalibrationFigure({ taskId }: { taskId: string }) {
  const [data, setData] = useState<CalibrationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run() {
    if (loading) return;
    setLoading(true);
    setError(null);
    authFetch(withSession(`/api/calibrate-ner/${encodeURIComponent(taskId)}`))
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body?.error ?? body?.message ?? `HTTP ${r.status}`);
          return;
        }
        const body = (await r.json()) as CalibrationResponse;
        setData(body);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { run(); /* eslint-disable-next-line */ }, [taskId]);

  return (
    <div className="space-y-4 text-[12.5px]">
      <p className="text-muted-foreground">
        F1 between each agent's draft and your validated spans, scoped to
        notes you marked validated. Aggregated across the whole cohort —
        per-entity-type breakdown below.
      </p>

      {loading && (
        <div className="text-muted-foreground italic">Computing F1…</div>
      )}
      {error && (
        <div className="text-[hsl(var(--oxblood))]">
          Failed to compute calibration: {error}
        </div>
      )}

      {data && (
        <>
          {/* Cohort summary */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-md border border-border bg-card px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Validated notes
              </div>
              <div className="text-[18px] font-semibold mt-0.5">{data.n_validated_notes}</div>
              <div className="text-[10px] text-muted-foreground/80 mt-0.5">
                across {data.n_patients} patient{data.n_patients === 1 ? "" : "s"}
              </div>
            </div>
            <div className="rounded-md border border-border bg-card px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Reviewer spans
              </div>
              <div className="text-[18px] font-semibold mt-0.5">{data.n_reviewer_spans}</div>
              <div className="text-[10px] text-muted-foreground/80 mt-0.5">ground truth</div>
            </div>
            <div className="rounded-md border border-border bg-card px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Agents compared
              </div>
              <div className="text-[18px] font-semibold mt-0.5">{data.agents.length}</div>
              <div className="text-[10px] text-muted-foreground/80 mt-0.5">
                {data.agents.map((a) => a.agent_id).join(", ") || "—"}
              </div>
            </div>
          </div>

          {/* Per-agent headline + per-entity-type breakdown */}
          {data.agents.length === 0 && (
            <div className="rounded-md border border-border bg-card px-4 py-3 text-muted-foreground">
              No agent drafts found for any validated patient yet — run agents
              and validate at least one note, then come back.
            </div>
          )}
          {data.agents.map((a) => (
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
                    <div className="text-[20px] font-semibold">
                      {fmtNum(a.macro_f1)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Tuple κ
                    </div>
                    <div className="text-[20px] font-semibold">
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
                        <td className="px-2 py-1.5 text-right">{fmtNum(m.precision)}</td>
                        <td className="px-2 py-1.5 text-right">{fmtNum(m.recall)}</td>
                        <td className="px-2 py-1.5 text-right font-medium">{fmtNum(m.f1)}</td>
                        <td className="px-2 py-1.5 text-right">{m.agree}</td>
                        <td className="px-2 py-1.5 text-right">{m.miss_only_a}</td>
                        <td className="px-4 py-1.5 text-right">{m.miss_only_b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

          <button
            type="button"
            onClick={run}
            disabled={loading}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            Recompute
          </button>
        </>
      )}
    </div>
  );
}
