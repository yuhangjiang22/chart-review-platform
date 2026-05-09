import { Check, Circle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Phase, MaturityState } from "./phase-logic";
import {
  PHASE_ORDER,
  PHASE_LABEL,
  ITER_PHASES,
  EXIT_PHASES,
} from "./phases";

// Canonical lists (PHASE_ORDER / ITER_PHASES / EXIT_PHASES / PHASE_LABEL)
// live in phases.ts so editing this one file is enough to add or reorder
// a phase. AUTHOR → TRY → JUDGE → VALIDATE → DECIDE is the iteration
// cycle; LOCK + DEPLOY are the exit ramp. We render the two visual
// groups separated by a gate marker so the cyclic shape is legible.

// Re-export PHASE_ORDER for callers that imported from this module
// historically — the legacy import path keeps working.
export { PHASE_ORDER };

/**
 * Compute which phases are checked (done) based on guideline maturity.
 *
 * JUDGE is optional — never auto-marked done, since reviewers can skip
 * it. The pill renders as upcoming/active as appropriate but doesn't
 * receive a checkmark from maturity alone.
 *
 * | Maturity     | Phases marked done                        |
 * |--------------|-------------------------------------------|
 * | authoring    | none                                      |
 * | draft        | AUTHOR                                    |
 * | piloted      | AUTHOR + TRY + VALIDATE                   |
 * | calibrated   | + DECIDE + LOCK                           |
 * | locked       | (same as calibrated)                      |
 * | deployed     | all                                       |
 */
export function maturityToDonePhases(maturity: MaturityState | "authoring" | "deployed"): Phase[] {
  switch (maturity) {
    case "authoring":
      return [];
    case "draft":
      return ["AUTHOR"];
    case "piloted":
      return ["AUTHOR", "TRY", "VALIDATE"];
    case "calibrated":
      return ["AUTHOR", "TRY", "VALIDATE", "DECIDE", "LOCK"];
    case "locked":
      return ["AUTHOR", "TRY", "VALIDATE", "DECIDE", "LOCK"];
    case "deployed":
      return [...PHASE_ORDER];
    default:
      return [];
  }
}

interface PhasePillBarProps {
  activePhase: Phase;
  /** Phases that are fully done for this version. When maturity is provided,
   *  it takes precedence over donePhases for the checkmark mapping. */
  donePhases: Phase[];
  /** Guideline maturity level — when provided, drives checkmark visibility
   *  using the maturity-keyed mapping instead of donePhases. */
  maturity?: MaturityState | "authoring" | "deployed";
  onPhaseClick?: (phase: Phase) => void;
}

export function PhasePillBar({
  activePhase,
  donePhases,
  maturity,
  onPhaseClick,
}: PhasePillBarProps) {
  // When maturity is provided, derive done-phases from the keyed mapping;
  // fall back to the explicit donePhases prop otherwise. (cluster 9 — W2)
  const effectiveDone: Phase[] = maturity !== undefined
    ? maturityToDonePhases(maturity)
    : donePhases;

  function renderPill(phase: Phase, withConnector: boolean) {
    const isDone = effectiveDone.includes(phase);
    const isActive = phase === activePhase;
    return (
      <div key={phase} className="flex items-center gap-1">
        {withConnector && (
          <span
            aria-hidden
            className={cn(
              "h-px w-5 shrink-0 transition-colors",
              isDone || isActive ? "bg-foreground/30" : "bg-border",
            )}
          />
        )}
        <button
          type="button"
          onClick={() => onPhaseClick?.(phase)}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] transition-all",
            isActive
              ? "border-foreground bg-foreground text-background"
              : isDone
                ? "border-[hsl(var(--sage))]/60 bg-[hsl(var(--sage))]/10 text-[hsl(var(--sage))]"
                : "border-border bg-transparent text-muted-foreground opacity-50",
            !isActive && "cursor-pointer hover:opacity-80",
          )}
          aria-current={isActive ? "step" : undefined}
          aria-label={`${PHASE_LABEL[phase]} phase${isDone ? " (complete)" : isActive ? " (active)" : " (upcoming)"}`}
        >
          {isDone ? (
            <Check size={10} strokeWidth={2.5} aria-hidden />
          ) : isActive ? (
            <Circle size={8} fill="currentColor" aria-hidden />
          ) : null}
          {PHASE_LABEL[phase]}
        </button>
      </div>
    );
  }

  return (
    <nav
      aria-label="Workflow phases"
      className="flex items-center gap-2 overflow-x-auto py-2"
    >
      {/* Iteration cycle group — Author → Try → Validate → Decide, with a
       *  loop-back affordance on the right edge of the group. The icon is
       *  clickable as a shortcut for "back to Author to start the next iter". */}
      <div className="flex items-center gap-1 rounded-full border border-dashed border-border/70 px-2 py-1">
        {ITER_PHASES.map((phase, i) => renderPill(phase, i > 0))}
        <button
          type="button"
          onClick={() => onPhaseClick?.("AUTHOR")}
          className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          title="Loop back to Author — start the next iteration"
          aria-label="Loop back to Author"
        >
          <RotateCcw size={11} strokeWidth={2} />
        </button>
      </div>

      {/* Gate marker between the iteration loop and the terminal phases. */}
      <span
        aria-hidden
        className="px-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70"
      >
        gate
      </span>

      {/* Terminal group — Lock + Deploy, the one-way exit. */}
      <div className="flex items-center gap-1">
        {EXIT_PHASES.map((phase, i) => renderPill(phase, i > 0))}
      </div>
    </nav>
  );
}
