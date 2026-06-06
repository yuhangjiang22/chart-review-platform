import { useState } from "react";
import { CalibrationFigure, RulesFigure, MethodsFigure, BundlesFigure } from "../Studio";
import { cn } from "@/lib/utils";
import { CheckSquare, Square } from "lucide-react";
import { CodifyButton } from "./CodifyButton";

interface PhaseLockProps {
  taskId: string;
  reviewerId: string;
  isMethodologist: boolean;
  /** Kept for API compatibility with Workspace caller — phenotype only now. */
  taskKind?: "phenotype";
}

type LockStep = "calibration" | "rules" | "methods" | "bundles";

interface StepDef {
  id: LockStep;
  label: string;
  description: string;
}

const STEPS: StepDef[] = [
  { id: "calibration", label: "Run calibration (κ)", description: "Measure inter-rater agreement — overall κ ≥ 0.6 required." },
  { id: "rules", label: "Drain rule queue", description: "Accept or reject all pending rule proposals." },
  { id: "methods", label: "Draft methods section", description: "Generate the manuscript methods section from the locked rubric." },
  { id: "bundles", label: "Export reproducibility bundle", description: "Package everything for the collaborator handoff." },
];

/**
 * LOCK phase — presents the four lock prerequisites as a sequential checklist.
 */
export function PhaseLock({ taskId, reviewerId, isMethodologist }: PhaseLockProps) {
  const [openStep, setOpenStep] = useState<LockStep>("calibration");
  const [done, setDone] = useState<Set<LockStep>>(new Set());

  function toggleDone(step: LockStep) {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        Lock prerequisites — complete each step before locking the version.
      </div>
      {STEPS.map((step) => {
        const isOpen = openStep === step.id;
        const isDone = done.has(step.id);
        return (
          <div
            key={step.id}
            className={cn(
              "rounded-md border transition-colors",
              isDone ? "border-[hsl(var(--sage))]/40 bg-[hsl(var(--sage))]/5" : "border-border bg-card",
            )}
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                onClick={() => toggleDone(step.id)}
                className={cn(
                  "shrink-0 transition-colors",
                  isDone ? "text-[hsl(var(--sage))]" : "text-muted-foreground hover:text-foreground",
                )}
                aria-label={isDone ? `Mark ${step.label} incomplete` : `Mark ${step.label} complete`}
              >
                {isDone ? <CheckSquare size={16} /> : <Square size={16} />}
              </button>
              <button
                type="button"
                onClick={() => setOpenStep(isOpen ? "calibration" : step.id)}
                className="flex-1 text-left"
              >
                <div className={cn("text-[13px] font-medium", isDone && "line-through text-muted-foreground")}>
                  {step.label}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{step.description}</div>
              </button>
            </div>
            {isOpen && (
              <div className="border-t border-border/60 px-4 py-4">
                {step.id === "calibration" && <CalibrationFigure taskId={taskId} />}
                {step.id === "rules" && (
                  <RulesFigure
                    taskId={taskId}
                    reviewerId={reviewerId}
                    isMethodologist={isMethodologist}
                  />
                )}
                {step.id === "methods" && <MethodsFigure taskId={taskId} />}
                {step.id === "bundles" && <BundlesFigure taskId={taskId} />}
              </div>
            )}
          </div>
        );
      })}
      </div>

      <div className="border-t border-border/60 pt-4">
        <CodifyButton taskId={taskId} />
      </div>
    </div>
  );
}
