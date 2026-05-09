// PhaseJudge — optional pre-screening phase between TRY and VALIDATE.
//
// Hosts the LLM-as-judge batch trigger + status. The judge analyzes
// disagreements + low-confidence cells + type-drift cells from the
// most-recent agent run, writes <task>/pilots/<iter>/judge_analyses.json,
// and PatientReview reads that file to surface advisory panels above
// each disputed criterion in VALIDATE.
//
// This phase is OPTIONAL — reviewers who want to validate without
// LLM pre-screening simply navigate past it. The pill bar exposes the
// JUDGE pill with `optional: true`; nothing gates VALIDATE on the judge
// having run.

import { useEffect, useState } from "react";
import { ArrowRight, Sparkles, Loader2 } from "lucide-react";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";

interface PhaseJudgeProps {
  taskId: string;
  /** Iter the judge analyses against. Same iter the VALIDATE phase will
   *  surface the analyses on. */
  iterId: string;
  /** Skip-to-validate affordance — navigates the workspace to VALIDATE
   *  without running the judge. */
  onSkipToValidate: () => void;
}

interface JudgeStatus {
  running: boolean;
  cellsAnalyzed?: number;
  cellsFailed?: number;
  generatedAt?: string;
  totalCostUsd?: number;
}

export function PhaseJudge({ taskId, iterId, onSkipToValidate }: PhaseJudgeProps) {
  const [status, setStatus] = useState<JudgeStatus>({ running: false });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const r = await authFetch(
        `/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/judge`,
      );
      if (!r.ok || cancelled) return;
      const body = await r.json();
      if (cancelled) return;
      setStatus({
        running: !!body.running,
        cellsAnalyzed:
          typeof body.cells_analyzed === "number" ? body.cells_analyzed : undefined,
        cellsFailed:
          typeof body.cells_failed === "number" ? body.cells_failed : undefined,
        generatedAt:
          typeof body.generated_at === "string" ? body.generated_at : undefined,
        totalCostUsd:
          typeof body.total_cost_usd === "number" ? body.total_cost_usd : undefined,
      });
    }
    load();
    // Poll while running so the button reflects completion without a refresh.
    const handle = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [taskId, iterId]);

  async function runJudge() {
    setStatus((s) => ({ ...s, running: true }));
    const r = await authFetch(
      `/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/judge`,
      { method: "POST" },
    );
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(`Could not start judge: ${body.error ?? r.status}`);
      setStatus((s) => ({ ...s, running: false }));
    }
    // Poll picks up the running flag + completion automatically.
  }

  const hasResults = !!status.generatedAt;

  return (
    <div className="pt-2 space-y-4">
      <div className="rounded-md border border-border bg-card p-4">
        <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Optional pre-screening
        </div>
        <h3 className="text-[14px] font-medium text-foreground mb-1">
          LLM-as-judge: pre-screen disagreements before reviewer adjudication
        </h3>
        <p className="text-[12px] text-muted-foreground leading-snug max-w-prose">
          A more capable model reviews each (patient, criterion) cell where the
          two agents disagreed, where one agent reported low confidence, or
          where they emitted different value formats. The output is advisory —
          the reviewer still adjudicates in VALIDATE — but it pre-fills the
          suggested answer + reasoning + evidence pointers.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="default"
            className="gap-1.5"
            onClick={runJudge}
            disabled={status.running}
            aria-label="Run judge analysis"
          >
            {status.running ? (
              <>
                <Loader2 size={12} strokeWidth={1.75} className="animate-spin" />
                Judge running…
              </>
            ) : hasResults ? (
              <>
                <Sparkles size={12} strokeWidth={1.75} />
                Re-run judge ({status.cellsAnalyzed ?? 0} cells)
              </>
            ) : (
              <>
                <Sparkles size={12} strokeWidth={1.75} />
                Run judge analysis
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={onSkipToValidate}
          >
            {hasResults ? "Continue to validate" : "Skip — go straight to validate"}
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
        </div>

        {status.generatedAt && !status.running && (
          <div className="mt-3 text-[11px] text-muted-foreground border-t border-border/50 pt-2">
            <div>
              <span className="font-medium text-foreground">
                {status.cellsAnalyzed ?? 0}
              </span>{" "}
              cells analyzed
              {status.cellsFailed ? (
                <>
                  {" · "}
                  <span className="text-[hsl(var(--oxblood))]">
                    {status.cellsFailed} failed
                  </span>
                </>
              ) : null}
              {typeof status.totalCostUsd === "number" ? (
                <>
                  {" · "}${status.totalCostUsd.toFixed(2)}
                </>
              ) : null}
            </div>
            <div className="mt-0.5 text-muted-foreground/70">
              Generated {new Date(status.generatedAt).toLocaleString()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
