import { useState } from "react";
import { CalibrationFigure, RulesFigure, MethodsFigure, BundlesFigure } from "../Studio";
import { cn } from "@/lib/utils";
import { CheckSquare, Square, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authFetch } from "../../auth";
import { CodifyButton } from "./CodifyButton";
import { NerCalibrationFigure } from "./NerCalibrationFigure";

interface PhaseLockProps {
  taskId: string;
  reviewerId: string;
  isMethodologist: boolean;
  /** NER vs phenotype — gates the rules-queue step (vestigial for NER)
   *  and swaps the calibration figure for a F1-against-reviewer one. */
  taskKind?: "phenotype" | "ner";
}

type LockStep = "calibration" | "rules" | "methods" | "bundles";

interface StepDef {
  id: LockStep;
  label: string;
  description: string;
  /** When true, this step is omitted for NER tasks. */
  phenotypeOnly?: boolean;
}

const PHENOTYPE_CALIBRATION: StepDef = {
  id: "calibration", label: "Run calibration (κ)",
  description: "Measure inter-rater agreement — overall κ ≥ 0.6 required.",
};
const NER_CALIBRATION: StepDef = {
  id: "calibration", label: "Check agent-vs-reviewer F1",
  description: "Compute per-entity-type F1 of each agent's draft against your validated spans.",
};
const STEPS: StepDef[] = [
  // calibration is inserted dynamically based on task_kind
  { id: "rules", label: "Drain rule queue", description: "Accept or reject all pending rule proposals.", phenotypeOnly: true },
  { id: "methods", label: "Draft methods section", description: "Generate the manuscript methods section from the locked rubric.", phenotypeOnly: true },
  { id: "bundles", label: "Export reproducibility bundle", description: "Package everything for the collaborator handoff." },
];

/**
 * LOCK phase — presents the four lock prerequisites as a sequential checklist.
 * Each step expands to show the corresponding existing figure from Studio.
 */
export function PhaseLock({ taskId, reviewerId, isMethodologist, taskKind }: PhaseLockProps) {
  const isNer = taskKind === "ner";
  // Build the effective step list — NER tasks drop the rules-queue step
  // (vestigial after my DECIDE proposals refactor) and use the F1
  // calibration variant.
  const calibrationStep = isNer ? NER_CALIBRATION : PHENOTYPE_CALIBRATION;
  const effectiveSteps: StepDef[] = [
    calibrationStep,
    ...STEPS.filter((s) => !s.phenotypeOnly || !isNer),
  ];
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
      {effectiveSteps.map((step) => {
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
                {step.id === "calibration" && (
                  isNer
                    ? <NerCalibrationFigure taskId={taskId} />
                    : <CalibrationFigure taskId={taskId} />
                )}
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

      {isNer && (
        <div className="border-t border-border/60 pt-4">
          <LockVersionButton taskId={taskId} />
        </div>
      )}

      <div className="border-t border-border/60 pt-4">
        <CodifyButton taskId={taskId} />
      </div>
    </div>
  );
}

/** Explicit "Lock this version" trigger for NER tasks — POSTs the
 *  calibrated → locked maturity transition. Pre-gate: shown only when
 *  maturity is already "calibrated" (the F1 calibration auto-advances
 *  to that state when the calibration card renders). */
function LockVersionButton({ taskId }: { taskId: string }) {
  const [locking, setLocking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  async function lockVersion() {
    if (locking) return;
    if (!confirm("Lock this version? Further edits will require an explicit unlock.")) return;
    setLocking(true);
    setErr(null);
    try {
      const r = await authFetch(
        `/api/guidelines/${encodeURIComponent(taskId)}/maturity`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: "locked" }),
        },
      );
      const body = await r.json().catch(() => ({} as { error?: string }));
      if (!r.ok) {
        setErr(body?.error ?? `HTTP ${r.status}`);
        return;
      }
      setSuccess(true);
      // Force a refresh so the pill colors flip to all-green.
      setTimeout(() => window.location.reload(), 500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLocking(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button
        variant="default"
        size="lg"
        className="h-14 gap-2"
        onClick={lockVersion}
        disabled={locking || success}
      >
        <Lock size={14} />
        {success ? "Locked ✓" : locking ? "Locking…" : "Lock this version"}
      </Button>
      <div className="text-[11px] text-muted-foreground">
        Freezes the annotation guidance + ontology + accepted proposals at the current SHA.
        No further edits accepted until an explicit unlock.
      </div>
      {err && (
        <div className="text-[11.5px] text-[hsl(var(--oxblood))]">
          Lock failed: {err}
        </div>
      )}
    </div>
  );
}
