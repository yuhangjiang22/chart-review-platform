import { Check, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Phase, MaturityState } from "./phase-logic";
import {
  PHASE_ORDER,
  PHASE_LABEL,
  ITER_PHASES,
} from "./phases";

// Canonical lists (PHASE_ORDER / ITER_PHASES / PHASE_LABEL)
// live in phases.ts so editing this one file is enough to add or reorder
// a phase. TRY → VALIDATE → DECIDE is the workflow cycle.

// Re-export PHASE_ORDER for callers that imported from this module
// historically — the legacy import path keeps working.
export { PHASE_ORDER };

/**
 * Compute which phases are checked (done) based on guideline maturity.
 *
 * | Maturity     | Phases marked done          |
 * |--------------|-----------------------------|
 * | authoring    | none                        |
 * | draft        | none                        |
 * | piloted      | TRY + VALIDATE              |
 * | calibrated   | TRY + VALIDATE + DECIDE     |
 * | locked       | TRY + VALIDATE + DECIDE     |
 * | deployed     | all                         |
 */
export function maturityToDonePhases(maturity: MaturityState | "authoring" | "deployed"): Phase[] {
  switch (maturity) {
    case "authoring":
    case "draft":
      return [];
    case "piloted":
      return ["TRY", "VALIDATE"];
    case "calibrated":
    case "locked":
      return ["TRY", "VALIDATE", "DECIDE"];
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
  /** Optional filter: only render phases in this list. When undefined,
   *  every phase from PHASE_DEFS shows. Populated by Workspace from
   *  GET /api/tasks/:taskId/phases.enabled (per-task meta.yaml config). */
  enabledPhases?: Phase[];
}

export function PhasePillBar({
  activePhase,
  donePhases,
  maturity,
  onPhaseClick,
  enabledPhases,
}: PhasePillBarProps) {
  // When maturity is provided, derive done-phases from the keyed mapping;
  // fall back to the explicit donePhases prop otherwise. (cluster 9 — W2)
  const effectiveDone: Phase[] = maturity !== undefined
    ? maturityToDonePhases(maturity)
    : donePhases;

  // Per-task phase filter. When set, only these phases render.
  const enabledSet: Set<Phase> | null = enabledPhases
    ? new Set(enabledPhases)
    : null;
  const isEnabled = (p: Phase) => !enabledSet || enabledSet.has(p);
  const iterPhasesToRender = ITER_PHASES.filter(isEnabled);

  function renderPill(phase: Phase, withConnector: boolean) {
    const isDone = effectiveDone.includes(phase);
    const isActive = phase === activePhase;
    return (
      <div key={phase} className="flex items-center gap-1">
        {withConnector && (
          <span
            aria-hidden
            className={cn(
              "h-px w-3.5 shrink-0 transition-colors",
              isDone || isActive ? "bg-foreground/30" : "bg-border",
            )}
          />
        )}
        <button
          type="button"
          onClick={() => onPhaseClick?.(phase)}
          className={cn(
            "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em] transition-all",
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
      className="flex items-center gap-1.5 overflow-x-auto py-2"
    >
      {/* Workflow cycle: TRY → VALIDATE → DECIDE */}
      <div className="flex items-center gap-1 rounded-full border border-dashed border-border/70 px-2 py-1">
        {iterPhasesToRender.map((phase, i) => renderPill(phase, i > 0))}
      </div>
    </nav>
  );
}
