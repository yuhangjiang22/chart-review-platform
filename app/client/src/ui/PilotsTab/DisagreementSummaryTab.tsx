// DisagreementSummaryTab — Task 6.7 of the dual-agent MVP plan.
// Read-only roll-up of disagreements by criterion, wired inside IterDetail.tsx.
import { useEffect, useState } from "react";
import { authFetch } from "../../auth";
import { cn } from "@/lib/utils";

/** Mirrors AgentAnswerSlot from server/disagreements.ts */
interface AgentAnswerSlot {
  value: string | null;
  status: "answered" | "skipped";
}

interface DisagreementRow {
  patient_id: string;
  agent_a_answer: AgentAnswerSlot;
  agent_b_answer: AgentAnswerSlot;
  pair: { agent_a: string; agent_b: string };
  kind: "hard" | "soft";
  resolved: boolean;
}

interface CriterionGroup {
  field_id: string;
  disagreement_count: number;
  hard_count: number;
  soft_count: number;
  rows: DisagreementRow[];
}

interface DisagreementSummaryTabProps {
  taskId: string;
  iterId: string;
  onOpenPatient: (patientId: string, fieldId: string) => void;
}

export function DisagreementSummaryTab({ taskId, iterId, onOpenPatient }: DisagreementSummaryTabProps) {
  const [groups, setGroups] = useState<CriterionGroup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      authFetch(`/api/pilots/${taskId}/${iterId}/disagreements`).then((r) =>
        r.ok ? r.json() : null,
      ),
      authFetch(`/api/pilots/${taskId}/${iterId}/adjudications`).then((r) =>
        r.ok ? r.json() : { adjudications: [] },
      ),
    ])
      .then(([disagreementsData, adjudicationsData]) => {
        const disagreements: Array<{
          patient_id: string;
          field_id: string;
          kind: "hard" | "soft";
          pair: { agent_a: string; agent_b: string };
          answers: { agent_a: AgentAnswerSlot; agent_b: AgentAnswerSlot };
        }> = disagreementsData?.disagreements ?? [];

        const adjudications: Array<{
          patient_id: string;
          field_id: string;
          pair: { agent_a: string; agent_b: string };
          classification: string;
        }> = adjudicationsData?.adjudications ?? [];

        // Build a set of resolved (patient_id, field_id) pairs.
        const resolvedKeys = new Set<string>(
          adjudications.map((a) => `${a.patient_id}::${a.field_id}::${a.pair.agent_a}::${a.pair.agent_b}`),
        );

        // Group by field_id.
        const byField = new Map<string, CriterionGroup>();
        for (const d of disagreements) {
          if (!byField.has(d.field_id)) {
            byField.set(d.field_id, {
              field_id: d.field_id,
              disagreement_count: 0,
              hard_count: 0,
              soft_count: 0,
              rows: [],
            });
          }
          const g = byField.get(d.field_id)!;
          g.disagreement_count++;
          if (d.kind === "hard") g.hard_count++;
          else g.soft_count++;

          const key = `${d.patient_id}::${d.field_id}::${d.pair.agent_a}::${d.pair.agent_b}`;
          g.rows.push({
            patient_id: d.patient_id,
            agent_a_answer: d.answers.agent_a,
            agent_b_answer: d.answers.agent_b,
            pair: d.pair,
            kind: d.kind,
            resolved: resolvedKeys.has(key),
          });
        }

        // Sort groups by disagreement_count descending.
        const sorted = [...byField.values()].sort(
          (a, b) => b.disagreement_count - a.disagreement_count,
        );
        setGroups(sorted);
      })
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [taskId, iterId]);

  if (loading) {
    return (
      <div className="px-5 py-6 text-[12px] italic text-muted-foreground">
        Loading disagreements…
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="px-5 py-6">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2">
          Disagreements
        </div>
        <div className="text-[12.5px] text-muted-foreground italic">No disagreements found.</div>
      </div>
    );
  }

  return (
    <div className="px-5 py-6 space-y-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">
        Disagreements by criterion
      </div>

      {groups.map((g) => {
        const hasHard = g.hard_count > 0;
        const ruleColor = hasHard
          ? "border-l-[hsl(var(--oxblood))]"
          : "border-l-[hsl(var(--ochre))]";

        return (
          <details
            key={g.field_id}
            className={cn(
              "rounded-md border border-border border-l-[3px] overflow-hidden",
              ruleColor,
            )}
          >
            <summary className="flex items-center gap-3 px-3 py-2 cursor-pointer select-none list-none">
              <span className="font-mono text-[12px] text-ink">{g.field_id}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {g.disagreement_count} disagreement{g.disagreement_count !== 1 ? "s" : ""}
              </span>
              {g.hard_count > 0 && (
                <span className="text-[10px] uppercase tracking-[0.14em] text-[hsl(var(--oxblood))]">
                  {g.hard_count} hard
                </span>
              )}
              {g.soft_count > 0 && (
                <span className="text-[10px] uppercase tracking-[0.14em] text-[hsl(var(--ochre))]">
                  {g.soft_count} soft
                </span>
              )}
            </summary>

            <div className="border-t border-border/50">
              {g.rows.map((row, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => onOpenPatient(row.patient_id, g.field_id)}
                  className="w-full grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-3 py-2 text-left hover:bg-muted/30 transition-colors border-b border-border/30 last:border-b-0"
                >
                  <span className="font-mono text-[11.5px] text-ink">{row.patient_id}</span>
                  <AnswerChip slot={row.agent_a_answer} label={row.pair.agent_a} />
                  <AnswerChip slot={row.agent_b_answer} label={row.pair.agent_b} />
                  {row.resolved ? (
                    <span className="text-[10px] uppercase tracking-[0.14em] text-[hsl(var(--sage))]">
                      (resolved)
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50">
                      open
                    </span>
                  )}
                </button>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function AnswerChip({ slot, label }: { slot: AgentAnswerSlot; label: string }) {
  // Skipped: agent committed no value for this criterion.
  if (slot.status === "skipped") {
    return (
      <span
        className="font-mono text-[11px] border rounded px-1 py-0.5 leading-none border-amber-400 bg-amber-50 text-amber-700 flex items-center gap-0.5"
        title={label}
        data-testid="agent-skipped-marker"
        aria-label={`${label}: agent did not commit a value for this criterion`}
      >
        ⚠️ skipped
      </span>
    );
  }

  const value = slot.value ?? "no_info";
  const isYes = value === "yes";
  const isNo = value === "no";

  const style = isYes
    ? "border-[hsl(var(--sage))] bg-[hsl(140_22%_96%)] text-[hsl(var(--sage))]"
    : isNo
    ? "border-[hsl(var(--oxblood))] bg-[hsl(354_50%_96%)] text-[hsl(var(--oxblood))]"
    : "border-[hsl(var(--slate,220_16%_60%))] bg-[hsl(220_16%_96%)] text-muted-foreground";

  return (
    <span
      className={cn(
        "font-mono text-[11px] border rounded px-1 py-0.5 leading-none",
        style,
      )}
      title={label}
    >
      {value}
    </span>
  );
}
