// Per-agent precision / recall / F1 panel rendered on the DECIDE pane
// when task_kind === "ner". Fetches /api/pilots/:taskId/:iterId/performance
// and renders one card per agent (overall metrics + expandable
// per-entity-type breakdown).
//
// "Score" = each agent's spans diffed against the reviewer's validated
// review_state.json span_labels — only spans inside validated_notes count
// as ground truth.

import { useEffect, useState } from "react";
import { authFetch } from "../../auth";
import { cn } from "@/lib/utils";

interface AgentCounts {
  tp: number;
  fp: number;
  fn: number;
  concept_edits: number;
  precision: number;
  recall: number;
  f1: number;
}

interface EntityTypeRow extends AgentCounts {
  entity_type: string;
}

interface AgentReport {
  agent_id: string;
  overall: AgentCounts;
  by_entity_type: EntityTypeRow[];
}

interface PerformanceReport {
  iter_id: string;
  run_id: string;
  task_id: string;
  patients_total: number;
  patients_with_validation: number;
  agents: AgentReport[];
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function scoreColor(f1: number): string {
  if (f1 >= 0.8) return "text-emerald-700";
  if (f1 >= 0.6) return "text-amber-700";
  return "text-[hsl(var(--oxblood))]";
}

export function NerDecideSummary({
  taskId, iterId,
}: { taskId: string; iterId: string }) {
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/pilots/${taskId}/${iterId}/performance`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: PerformanceReport) => { if (!cancelled) setReport(d); })
      .catch((e: Error) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [taskId, iterId]);

  if (err) {
    return (
      <div className="rounded-md border border-[hsl(var(--oxblood))]/30 bg-[hsl(var(--oxblood))]/5 px-4 py-3 text-[12.5px] text-[hsl(var(--oxblood))]">
        Performance fetch failed: {err}
      </div>
    );
  }
  if (!report) {
    return (
      <div className="text-[12px] text-muted-foreground">Computing performance…</div>
    );
  }
  if (report.patients_with_validation === 0) {
    return (
      <div className="text-[12.5px] text-muted-foreground">
        No reviewer-validated patients yet — validate at least one patient to see
        per-agent precision / recall / F1.
      </div>
    );
  }
  if (report.agents.length === 0) {
    return (
      <div className="text-[12.5px] text-muted-foreground">
        No agent spans found for this iter — the run may have errored.
      </div>
    );
  }

  function toggle(agentId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        Agent performance · {report.patients_with_validation}/{report.patients_total} patients validated
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {report.agents.map((a) => {
          const isOpen = expanded.has(a.agent_id);
          const m = a.overall;
          return (
            <div
              key={a.agent_id}
              className="rounded-md border border-border bg-paper/40 px-4 py-3"
            >
              <div className="flex items-baseline justify-between">
                <div className="font-mono text-[12px] text-ink">{a.agent_id}</div>
                <div className={cn("text-[11px]", scoreColor(m.f1))}>
                  F1 {pct(m.f1)}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
                <div>
                  <div className="text-muted-foreground">Precision</div>
                  <div className="font-mono text-ink">{pct(m.precision)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Recall</div>
                  <div className="font-mono text-ink">{pct(m.recall)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">F1</div>
                  <div className={cn("font-mono", scoreColor(m.f1))}>{pct(m.f1)}</div>
                </div>
              </div>

              <div className="mt-2 text-[10.5px] text-muted-foreground">
                {m.tp} kept · {m.fp} deleted · {m.fn} missed
                {m.concept_edits > 0 && ` · ${m.concept_edits} concept-edits`}
              </div>

              {a.by_entity_type.length > 0 && (
                <button
                  type="button"
                  className="mt-3 text-[11px] text-[hsl(var(--ink))]/70 hover:text-ink underline-offset-2 hover:underline"
                  onClick={() => toggle(a.agent_id)}
                >
                  {isOpen ? "Hide" : "Show"} by entity_type ({a.by_entity_type.length})
                </button>
              )}

              {isOpen && (
                <table className="mt-2 w-full text-[10.5px]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left font-normal">entity_type</th>
                      <th className="text-right font-normal">P</th>
                      <th className="text-right font-normal">R</th>
                      <th className="text-right font-normal">F1</th>
                      <th className="text-right font-normal">TP/FP/FN</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.by_entity_type.map((r) => (
                      <tr key={r.entity_type} className="font-mono">
                        <td className="text-left text-ink">{r.entity_type}</td>
                        <td className="text-right">{pct(r.precision)}</td>
                        <td className="text-right">{pct(r.recall)}</td>
                        <td className={cn("text-right", scoreColor(r.f1))}>{pct(r.f1)}</td>
                        <td className="text-right text-muted-foreground">
                          {r.tp}/{r.fp}/{r.fn}
                        </td>
                      </tr>
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
