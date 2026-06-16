// RefinementHistory — the visible half of self-refinement provenance (S4).
//
// Lists the rules that were applied to this task's criteria via the refinement
// loop: WHAT rule was added, to fix how many cases, the held-out Δ, who/when,
// and a [Revert] for any still-applied edit. Reads GET /api/refine/:taskId/log
// and posts /revert. Renders nothing when the log is empty, so it's invisible
// until the first rule is applied.

import { useCallback, useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { authFetch } from "../../auth";

interface HoldoutMeasured {
  insufficient_holdout?: false;
  delta: number;
  n_fixed: number;
  n_regressed: number;
  heldout_n: number;
}
interface HoldoutInsufficient {
  insufficient_holdout: true;
  heldout_n: number;
}
type Holdout = HoldoutMeasured | HoldoutInsufficient;

interface LogEntry {
  entry_id: string;
  field_id: string;
  applied_at: string;
  applied_by: string;
  proposed_rule_text: string;
  card?: {
    examples?: Array<unknown>;
    gap_summary?: string;
    holdout?: Holdout;
    refine_n?: number;
  };
  reverted?: { at: string; by: string; intervening_edit: boolean };
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** "+0.67 · fixed 2" | "no Δ" | "held-out n/a" */
function holdoutLabel(h: Holdout | undefined): string {
  if (!h) return "";
  if (h.insufficient_holdout) return "held-out n/a";
  const sign = h.delta >= 0 ? "+" : "";
  const parts = [`${sign}${h.delta.toFixed(2)} held-out`];
  if (h.n_fixed) parts.push(`fixed ${h.n_fixed}`);
  if (h.n_regressed) parts.push(`regressed ${h.n_regressed}`);
  return parts.join(" · ");
}

export function RefinementHistory({ taskId, activeSessionId }: { taskId: string; activeSessionId?: string | null }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // Scope to the active session so a session shows only ITS OWN refinements,
    // not every session's (the task-level log records a session_id per entry).
    const qs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";
    authFetch(`/api/refine/${encodeURIComponent(taskId)}/log${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { entries?: LogEntry[] }) => setEntries(d.entries ?? []))
      .catch(() => setEntries([])); // best-effort — no history is a valid state
  }, [taskId, activeSessionId]);

  useEffect(() => {
    load();
  }, [load]);

  async function revert(entryId: string) {
    setReverting(entryId);
    setError(null);
    try {
      const r = await authFetch(`/api/refine/${encodeURIComponent(taskId)}/revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_id: entryId }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string; intervening_edit?: boolean };
      if (!r.ok) {
        setError(body.error ?? `Revert failed: ${r.status}`);
        return;
      }
      if (body.intervening_edit) {
        setError("Reverted, but the criterion had been edited since — the earlier text was restored over those changes.");
      }
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReverting(null);
    }
  }

  // Hide entirely until the first rule is applied.
  if (!entries || entries.length === 0) return null;

  return (
    <section className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
        <History size={13} strokeWidth={1.75} />
        Refinement history
        <span className="text-[11px] font-normal text-muted-foreground">
          ({entries.length} applied {entries.length === 1 ? "rule" : "rules"})
        </span>
      </div>
      {error && <div className="text-[11.5px] text-destructive">{error}</div>}
      <ul className="space-y-2">
        {entries.map((e) => {
          const nCases = e.card?.examples?.length ?? e.card?.refine_n ?? 0;
          const ho = holdoutLabel(e.card?.holdout);
          const isReverted = !!e.reverted;
          return (
            <li
              key={e.entry_id}
              className={
                "rounded border border-border/50 bg-background/60 px-2.5 py-2 text-[12px] " +
                (isReverted ? "opacity-55" : "")
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-mono text-foreground">{e.field_id}</span>
                    {nCases > 0 && <span>fixes {nCases} {nCases === 1 ? "case" : "cases"}</span>}
                    {ho && <span className="tabular-nums">{ho}</span>}
                    <span>· {fmtDate(e.applied_at)} · {e.applied_by}</span>
                    {isReverted && (
                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide">
                        reverted
                      </span>
                    )}
                  </div>
                  <div className={isReverted ? "line-through text-muted-foreground" : "text-foreground"}>
                    {e.proposed_rule_text}
                  </div>
                </div>
                {!isReverted && (
                  <button
                    type="button"
                    onClick={() => revert(e.entry_id)}
                    disabled={reverting != null}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-60"
                  >
                    <RotateCcw size={10} strokeWidth={1.75} />
                    {reverting === e.entry_id ? "Reverting…" : "Revert"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
