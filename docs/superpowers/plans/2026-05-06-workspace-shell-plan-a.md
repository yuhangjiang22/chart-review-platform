# Workspace Shell (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `Studio.tsx`'s eight-tab domain grid with a six-phase `Workspace.tsx` shell that shows only the currently-active phase and its primary CTA, while preserving every existing tab component as a phase surface or "Show all tools" escape hatch.

**Architecture:** A pure-function `derivePhase` reads existing pilot-iter state + cell counts from existing endpoints; a matching `deriveNextCTA` translates phase+state into a single `{ label, action }`. Six thin phase-wrapper components (`PhaseDraft`, `PhaseTry`, `PhaseValidate`, `PhaseDecide`, `PhaseLock`, `PhaseDeploy`) slot existing figures directly. A top-level `Workspace` component orchestrates pill bar, phase headline, the active wrapper, and the CTA footer. `App.tsx` swaps its `<Studio …/>` render for `<Workspace …/>` on the `studio` route.

**Tech Stack:** React 18, TypeScript strict mode, Tailwind CSS (existing design tokens), Vitest + jsdom (existing test setup), `@radix-ui/react-tabs`, existing `authFetch`, `Button`, `Badge`, `cn` utilities. No new runtime deps.

**Spec:** `chart-review-platform/docs/superpowers/specs/2026-05-06-phase-driven-workspace-design.md`

**Branch:** `feat/phase-driven-workspace` — every subagent MUST run `git branch --show-current` and confirm the branch before each commit.

---

## File Structure

### New files created

| Path | Responsibility |
|---|---|
| `app/client/src/ui/Workspace/phase-logic.ts` | Pure exports: `Phase` type, `PhaseInfo`, `CellCounts`, `derivePhase`, `CTADescriptor`, `deriveNextCTA` |
| `app/client/src/ui/Workspace/phase-logic.test.ts` | Vitest unit tests for both pure functions (no DOM) |
| `app/client/src/ui/Workspace/PhasePillBar.tsx` | Pill bar row: six pills with done/active/future glyphs |
| `app/client/src/ui/Workspace/PhaseHeadline.tsx` | One-line headline: phase name + version tag + counts |
| `app/client/src/ui/Workspace/PhaseDraft.tsx` | Wraps `GuidelineFigure` |
| `app/client/src/ui/Workspace/PhaseTry.tsx` | Thin wrapper: kick-off panel wrapping `PilotsFigure` |
| `app/client/src/ui/Workspace/PhaseValidate.tsx` | Patients sub-tab + Revisits sub-tab using existing `PatientReview`-opener and `RevisitList` |
| `app/client/src/ui/Workspace/PhaseDecide.tsx` | Validation-summary + dual CTAs (Revise / Lock) |
| `app/client/src/ui/Workspace/PhaseLock.tsx` | Sequential checklist wrapping `CalibrationFigure`, `RulesFigure`, `MethodsFigure`, `BundlesFigure` from `Studio.tsx` (re-exported) |
| `app/client/src/ui/Workspace/PhaseDeploy.tsx` | Wraps `CohortsFigure` |
| `app/client/src/ui/Workspace/ShowAllToolsToggle.tsx` | Icon-only toggle; reads/writes `localStorage` per-task |
| `app/client/src/ui/Workspace/index.tsx` | `Workspace` top-level component; composes all the above |

### Modified files

| Path | Change |
|---|---|
| `app/client/src/ui/App.tsx` | Replace `<Studio …/>` with `<Workspace …/>` on `route.page === "studio"` |
| `app/client/src/ui/Studio.tsx` | Export `CalibrationFigure`, `RulesFigure`, `MethodsFigure`, `BundlesFigure` so `PhaseLock` can import them without duplicating code |

---

## Tasks

---

### Task 1: Phase derivation pure function (TDD)

**Files:**
- Create: `app/client/src/ui/Workspace/phase-logic.ts`
- Create: `app/client/src/ui/Workspace/phase-logic.test.ts`

- [ ] **Step 1: Create the test file with all cases**

```typescript
// app/client/src/ui/Workspace/phase-logic.test.ts
import { describe, it, expect } from "vitest";
import { derivePhase } from "./phase-logic";
import type { IterState, CellCounts } from "./phase-logic";

const noCells: CellCounts = { validated: 0, total: 10, stale: 0 };
const allFresh: CellCounts = { validated: 10, total: 10, stale: 0 };
const partialNoStale: CellCounts = { validated: 5, total: 10, stale: 0 };
const partialWithStale: CellCounts = { validated: 10, total: 10, stale: 2 };

describe("derivePhase — rule 1: locked + deployed", () => {
  it("returns DEPLOY when maturity locked and deployedCohortExists true", () => {
    const result = derivePhase("locked", null, noCells, true);
    expect(result.phase).toBe("DEPLOY");
  });
});

describe("derivePhase — rule 2: locked, no deploy", () => {
  it("returns LOCK when maturity locked and no deployed cohort", () => {
    const result = derivePhase("locked", null, noCells, false);
    expect(result.phase).toBe("LOCK");
    expect(result.status_label).toBe("ready to deploy");
  });
});

describe("derivePhase — rule 3: complete + all fresh → DECIDE (clean)", () => {
  it("returns DECIDE with 'validation complete' when iter complete and all cells fresh", () => {
    const result = derivePhase("draft", { state: "complete" } as IterState, allFresh, false);
    expect(result.phase).toBe("DECIDE");
    expect(result.status_label).toBe("validation complete");
  });
});

describe("derivePhase — rule 4: complete + stale cells → DECIDE (stale)", () => {
  it("returns DECIDE with 'complete, stale cells' when iter complete but cells stale", () => {
    const result = derivePhase("draft", { state: "complete" } as IterState, partialWithStale, false);
    expect(result.phase).toBe("DECIDE");
    expect(result.status_label).toBe("complete, stale cells");
  });
});

describe("derivePhase — rule 5: ready_to_validate with some validated → VALIDATE mid-flight", () => {
  it("returns VALIDATE when ready_to_validate and some cells validated", () => {
    const result = derivePhase("draft", { state: "ready_to_validate" } as IterState, partialNoStale, false);
    expect(result.phase).toBe("VALIDATE");
    expect(result.status_label).toBe("validating");
    expect(result.completeness).toEqual({ done: 5, total: 10 });
  });
});

describe("derivePhase — rule 5b: running + any validated → VALIDATE mid-flight", () => {
  it("returns VALIDATE when running and some cells validated", () => {
    const result = derivePhase("draft", { state: "running" } as IterState, partialNoStale, false);
    expect(result.phase).toBe("VALIDATE");
    expect(result.status_label).toBe("validating");
  });
});

describe("derivePhase — rule 6: running + no validated → TRY", () => {
  it("returns TRY when agent running and no cells validated", () => {
    const result = derivePhase("draft", { state: "running" } as IterState, noCells, false);
    expect(result.phase).toBe("TRY");
    expect(result.status_label).toBe("running");
  });
});

describe("derivePhase — rule 7: ready_to_validate + no validated → VALIDATE waiting", () => {
  it("returns VALIDATE when ready_to_validate but no cell validated yet", () => {
    const result = derivePhase("draft", { state: "ready_to_validate" } as IterState, noCells, false);
    expect(result.phase).toBe("VALIDATE");
    expect(result.status_label).toBe("awaiting validation");
  });
});

describe("derivePhase — rule 8: no iter → DRAFT", () => {
  it("returns DRAFT when no iter", () => {
    const result = derivePhase("draft", null, noCells, false);
    expect(result.phase).toBe("DRAFT");
  });

  it("returns DRAFT when iter is abandoned", () => {
    const result = derivePhase("draft", { state: "abandoned" } as IterState, noCells, false);
    expect(result.phase).toBe("DRAFT");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /path/to/chart-review-platform/app && npx vitest run client/src/ui/Workspace/phase-logic.test.ts 2>&1 | head -30
```

Expected: FAIL with `Cannot find module './phase-logic'`

- [ ] **Step 3: Create the implementation**

```typescript
// app/client/src/ui/Workspace/phase-logic.ts

export type Phase = "DRAFT" | "TRY" | "VALIDATE" | "DECIDE" | "LOCK" | "DEPLOY";

export type MaturityState = "draft" | "piloted" | "calibrated" | "locked";

/** Iter states from the existing pilot manifest. `abandoned` is a terminal. */
export type IterStateValue =
  | "running"
  | "ready_to_validate"
  | "complete"
  | "abandoned";

export interface IterState {
  state: IterStateValue;
}

export interface CellCounts {
  /** Number of patients whose oracle_done flag is true (×criteria, approximated). */
  validated: number;
  /** Total patients × criteria (approximation for Plan A). */
  total: number;
  /** Cells that are stale due to criterion edits (from revisits endpoint). */
  stale: number;
}

export interface PhaseInfo {
  phase: Phase;
  completeness: { done: number; total: number } | null;
  status_label: string;
}

/**
 * Derive the active workflow phase from existing data.
 * Rules apply in order — first match wins.
 *
 * @param maturity   - Task's maturity state from GET /api/guidelines/:taskId/maturity
 * @param latestIter - Most recent non-abandoned iter (or null). Abandoned iters should
 *                     be filtered out before passing — pass null when all are abandoned.
 * @param cells      - Cell completeness counts (approximate in Plan A)
 * @param deployedCohortExists - True when at least one production cohort run exists
 */
export function derivePhase(
  maturity: MaturityState,
  latestIter: IterState | null,
  cells: CellCounts,
  deployedCohortExists: boolean,
): PhaseInfo {
  // Rule 1: locked + deployed → DEPLOY
  if (maturity === "locked" && deployedCohortExists) {
    return {
      phase: "DEPLOY",
      completeness: null,
      status_label: "deployed",
    };
  }

  // Rule 2: locked, no deploy yet → LOCK
  if (maturity === "locked") {
    return {
      phase: "LOCK",
      completeness: null,
      status_label: "ready to deploy",
    };
  }

  // Treat abandoned iter same as no iter for rules 3–7
  const iter = latestIter?.state === "abandoned" ? null : latestIter;

  // Rule 3: complete + all cells fresh → DECIDE (clean)
  if (iter?.state === "complete" && cells.stale === 0 && cells.validated >= cells.total && cells.total > 0) {
    return {
      phase: "DECIDE",
      completeness: { done: cells.validated, total: cells.total },
      status_label: "validation complete",
    };
  }

  // Rule 4: complete + stale cells → DECIDE (stale)
  if (iter?.state === "complete") {
    return {
      phase: "DECIDE",
      completeness: { done: cells.validated, total: cells.total },
      status_label: "complete, stale cells",
    };
  }

  // Rule 5: ready_to_validate OR running AND any cell validated → VALIDATE (mid-flight)
  if (
    (iter?.state === "ready_to_validate" || iter?.state === "running") &&
    cells.validated > 0
  ) {
    return {
      phase: "VALIDATE",
      completeness: { done: cells.validated, total: cells.total },
      status_label: "validating",
    };
  }

  // Rule 6: running + no cell validated → TRY
  if (iter?.state === "running" && cells.validated === 0) {
    return {
      phase: "TRY",
      completeness: null,
      status_label: "running",
    };
  }

  // Rule 7: ready_to_validate + no cell validated → VALIDATE (waiting)
  if (iter?.state === "ready_to_validate" && cells.validated === 0) {
    return {
      phase: "VALIDATE",
      completeness: { done: 0, total: cells.total },
      status_label: "awaiting validation",
    };
  }

  // Rule 8: no iter or all abandoned → DRAFT
  return {
    phase: "DRAFT",
    completeness: null,
    status_label: "drafting",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /path/to/chart-review-platform/app && npx vitest run client/src/ui/Workspace/phase-logic.test.ts
```

Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/Workspace/phase-logic.ts app/client/src/ui/Workspace/phase-logic.test.ts
git commit -m "feat(workspace): add derivePhase pure function with full TDD coverage"
```

---

### Task 2: CTA derivation pure function (TDD)

**Files:**
- Modify: `app/client/src/ui/Workspace/phase-logic.ts` (add `CTADescriptor` + `deriveNextCTA`)
- Modify: `app/client/src/ui/Workspace/phase-logic.test.ts` (add CTA tests)

- [ ] **Step 1: Add failing CTA tests to the test file**

Append to `app/client/src/ui/Workspace/phase-logic.test.ts`:

```typescript
import { deriveNextCTA } from "./phase-logic";
import type { CTADescriptor } from "./phase-logic";

describe("deriveNextCTA — DRAFT phase", () => {
  it("returns 'Edit a criterion' when idle (no cells)", () => {
    const cta = deriveNextCTA("DRAFT", "drafting", { validated: 0, total: 0, stale: 0 });
    expect(cta.label).toBe("Edit a criterion");
    expect(cta.action).toBe("open-draft");
  });
});

describe("deriveNextCTA — TRY phase", () => {
  it("returns 'Run agent' CTA referencing patient count", () => {
    const cta = deriveNextCTA("TRY", "running", { validated: 0, total: 8, stale: 0 });
    expect(cta.label).toMatch(/Run agent on 8 patients/);
    expect(cta.action).toBe("run-agent");
  });
});

describe("deriveNextCTA — VALIDATE phase, partial", () => {
  it("returns 'Validate next patient' while cells remain", () => {
    const cta = deriveNextCTA("VALIDATE", "validating", { validated: 3, total: 10, stale: 0 });
    expect(cta.label).toBe("Validate next patient");
    expect(cta.action).toBe("open-validate");
  });
});

describe("deriveNextCTA — VALIDATE phase, complete", () => {
  it("returns 'Continue to DECIDE' when all validated", () => {
    const cta = deriveNextCTA("VALIDATE", "validating", { validated: 10, total: 10, stale: 0 });
    expect(cta.label).toBe("All validated — continue to DECIDE");
    expect(cta.action).toBe("advance-decide");
  });
});

describe("deriveNextCTA — DECIDE phase", () => {
  it("returns Revise CTA when status is validation complete", () => {
    const cta = deriveNextCTA("DECIDE", "validation complete", { validated: 10, total: 10, stale: 0 });
    expect(cta.label).toBe("Revise");
    expect(cta.action).toBe("revise");
  });
});

describe("deriveNextCTA — LOCK phase", () => {
  it("returns 'Run calibration' CTA", () => {
    const cta = deriveNextCTA("LOCK", "ready to deploy", { validated: 10, total: 10, stale: 0 });
    expect(cta.label).toBe("Run calibration");
    expect(cta.action).toBe("run-calibration");
  });
});

describe("deriveNextCTA — DEPLOY phase", () => {
  it("returns 'Run on cohort' CTA", () => {
    const cta = deriveNextCTA("DEPLOY", "deployed", { validated: 0, total: 0, stale: 0 });
    expect(cta.label).toBe("Run on cohort");
    expect(cta.action).toBe("run-cohort");
  });
});
```

- [ ] **Step 2: Run tests to verify the new tests fail**

```bash
cd /path/to/chart-review-platform/app && npx vitest run client/src/ui/Workspace/phase-logic.test.ts 2>&1 | grep -E "FAIL|PASS|Error" | head -20
```

Expected: New 7 tests FAIL with `deriveNextCTA is not a function`

- [ ] **Step 3: Add `CTADescriptor` and `deriveNextCTA` to phase-logic.ts**

Append to `app/client/src/ui/Workspace/phase-logic.ts`:

```typescript
export type CTAAction =
  | "open-draft"
  | "run-agent"
  | "open-validate"
  | "advance-decide"
  | "revise"
  | "lock"
  | "run-calibration"
  | "run-lock-test"
  | "lock-version"
  | "run-cohort";

export interface CTADescriptor {
  label: string;
  action: CTAAction;
}

/**
 * Derive the single primary CTA for the given phase + state + cell counts.
 * For DECIDE, this returns the "Revise" option; the "Lock" CTA is always
 * shown alongside it in PhaseDecide — both are primary CTAs of equal weight.
 */
export function deriveNextCTA(
  phase: Phase,
  status_label: string,
  cells: CellCounts,
): CTADescriptor {
  switch (phase) {
    case "DRAFT":
      return { label: "Edit a criterion", action: "open-draft" };

    case "TRY":
      return {
        label: `Run agent on ${cells.total} patients`,
        action: "run-agent",
      };

    case "VALIDATE": {
      const remaining = cells.total - cells.validated;
      if (remaining <= 0) {
        return { label: "All validated — continue to DECIDE", action: "advance-decide" };
      }
      return { label: "Validate next patient", action: "open-validate" };
    }

    case "DECIDE":
      // Primary CTA is Revise; Lock is always shown as the secondary equal CTA in PhaseDecide
      return { label: "Revise", action: "revise" };

    case "LOCK":
      // Sequenced: first calibration, then lock test, then lock. Default to first step.
      return { label: "Run calibration", action: "run-calibration" };

    case "DEPLOY":
      return { label: "Run on cohort", action: "run-cohort" };
  }
}
```

- [ ] **Step 4: Run all phase-logic tests**

```bash
cd /path/to/chart-review-platform/app && npx vitest run client/src/ui/Workspace/phase-logic.test.ts
```

Expected: All 17 tests PASS

- [ ] **Step 5: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/Workspace/phase-logic.ts app/client/src/ui/Workspace/phase-logic.test.ts
git commit -m "feat(workspace): add deriveNextCTA pure function with TDD coverage"
```

---

### Task 3: PhasePillBar component

**Files:**
- Create: `app/client/src/ui/Workspace/PhasePillBar.tsx`

- [ ] **Step 1: Write the component**

```tsx
// app/client/src/ui/Workspace/PhasePillBar.tsx
import { Check, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Phase } from "./phase-logic";

export const PHASE_ORDER: Phase[] = [
  "DRAFT",
  "TRY",
  "VALIDATE",
  "DECIDE",
  "LOCK",
  "DEPLOY",
];

const PHASE_LABEL: Record<Phase, string> = {
  DRAFT: "Draft",
  TRY: "Try",
  VALIDATE: "Validate",
  DECIDE: "Decide",
  LOCK: "Lock",
  DEPLOY: "Deploy",
};

interface PhasePillBarProps {
  activePhase: Phase;
  /** Phases that are fully done for this version. */
  donePhases: Phase[];
  /** When true, every pill is clickable regardless of completeness. */
  freeNav: boolean;
  onPhaseClick?: (phase: Phase) => void;
}

export function PhasePillBar({
  activePhase,
  donePhases,
  freeNav,
  onPhaseClick,
}: PhasePillBarProps) {
  return (
    <nav
      aria-label="Workflow phases"
      className="flex items-center gap-1 overflow-x-auto py-2"
    >
      {PHASE_ORDER.map((phase, idx) => {
        const isDone = donePhases.includes(phase);
        const isActive = phase === activePhase;
        const isFuture = !isDone && !isActive;
        const isClickable = freeNav || isDone;

        return (
          <div key={phase} className="flex items-center gap-1">
            {idx > 0 && (
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
              disabled={!isClickable}
              onClick={() => isClickable && onPhaseClick?.(phase)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] transition-all",
                isActive
                  ? "border-foreground bg-foreground text-background"
                  : isDone
                  ? "border-[hsl(var(--sage))]/60 bg-[hsl(var(--sage))]/10 text-[hsl(var(--sage))]"
                  : "border-border bg-transparent text-muted-foreground opacity-50",
                isClickable && !isActive && "cursor-pointer hover:opacity-80",
                !isClickable && "cursor-default",
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
      })}
    </nav>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd /path/to/chart-review-platform/app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Workspace/PhasePillBar|error TS" | head -20
```

Expected: No errors for `PhasePillBar.tsx`

- [ ] **Step 3: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/Workspace/PhasePillBar.tsx
git commit -m "feat(workspace): add PhasePillBar component"
```

---

### Task 4: PhaseHeadline component

**Files:**
- Create: `app/client/src/ui/Workspace/PhaseHeadline.tsx`

- [ ] **Step 1: Write the component**

```tsx
// app/client/src/ui/Workspace/PhaseHeadline.tsx
import type { Phase, PhaseInfo } from "./phase-logic";

const PHASE_LABEL: Record<Phase, string> = {
  DRAFT: "DRAFT",
  TRY: "TRY",
  VALIDATE: "VALIDATE",
  DECIDE: "DECIDE",
  LOCK: "LOCK",
  DEPLOY: "DEPLOY",
};

interface PhaseHeadlineProps {
  phaseInfo: PhaseInfo;
  /** Version tag, e.g. "v3" or the task's manual_version. */
  versionTag: string | null;
}

export function PhaseHeadline({ phaseInfo, versionTag }: PhaseHeadlineProps) {
  const { phase, completeness, status_label } = phaseInfo;

  const countFragment =
    completeness && completeness.total > 0
      ? `${completeness.done} of ${completeness.total} cells validated`
      : null;

  return (
    <div className="flex min-w-0 items-baseline gap-2 py-1">
      <span className="font-display text-[13px] font-semibold uppercase tracking-[0.18em] text-foreground">
        {PHASE_LABEL[phase]}
      </span>
      {versionTag && (
        <code className="font-mono text-[12px] text-ink">{versionTag}</code>
      )}
      {countFragment && (
        <span className="text-[12px] text-muted-foreground">{countFragment}</span>
      )}
      {!countFragment && status_label && (
        <span className="text-[12px] text-muted-foreground">{status_label}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd /path/to/chart-review-platform/app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Workspace/PhaseHeadline|error TS" | head -20
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/Workspace/PhaseHeadline.tsx
git commit -m "feat(workspace): add PhaseHeadline component"
```

---

### Task 5: PhaseDraft and PhaseTry wrappers

**Files:**
- Create: `app/client/src/ui/Workspace/PhaseDraft.tsx`
- Create: `app/client/src/ui/Workspace/PhaseTry.tsx`

- [ ] **Step 1: Write PhaseDraft**

```tsx
// app/client/src/ui/Workspace/PhaseDraft.tsx
import { GuidelineFigure } from "../GuidelineTab";

interface PhaseDraftProps {
  taskId: string;
  onEdit?: (maturityState: string | null) => void;
}

/** DRAFT phase — thin wrapper around the existing GuidelineFigure. */
export function PhaseDraft({ taskId, onEdit }: PhaseDraftProps) {
  return <GuidelineFigure taskId={taskId} onEdit={onEdit} />;
}
```

- [ ] **Step 2: Write PhaseTry**

```tsx
// app/client/src/ui/Workspace/PhaseTry.tsx
import { PilotsFigure } from "../PilotsTab";
import { EmptyHint } from "../figure-primitives";
import { FlaskConical } from "lucide-react";

interface PhaseTryProps {
  taskId: string;
  /** Whether the task has at least one iter (including abandoned). */
  hasAnyIter: boolean;
  onOpenPatient?: (patientId: string, fieldId?: string) => void;
}

/**
 * TRY phase — surfaces the existing PilotsFigure which contains the
 * iter launch panel (cohort picker + "Run agent" button). Shows an
 * explanation card when no iter has ever been started.
 */
export function PhaseTry({ taskId, hasAnyIter, onOpenPatient }: PhaseTryProps) {
  return (
    <div className="space-y-6">
      {!hasAnyIter && (
        <EmptyHint
          icon={FlaskConical}
          title="Pick a patient sample and run the agent"
          body="The agent reads every patient chart against every criterion and proposes an answer. Once it finishes, you'll validate its work in the VALIDATE phase."
        />
      )}
      <PilotsFigure taskId={taskId} onOpenPatient={onOpenPatient} />
    </div>
  );
}
```

- [ ] **Step 3: Type-check both**

```bash
cd /path/to/chart-review-platform/app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Workspace/PhaseDraft|Workspace/PhaseTry|error TS" | head -20
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/Workspace/PhaseDraft.tsx app/client/src/ui/Workspace/PhaseTry.tsx
git commit -m "feat(workspace): add PhaseDraft and PhaseTry wrappers"
```

---

### Task 6: PhaseValidate wrapper

**Files:**
- Create: `app/client/src/ui/Workspace/PhaseValidate.tsx`

PhaseValidate shows a sub-tab switcher between "Patients" (linking out to individual `PatientReview` charts via `onOpenPatient`) and "Revisits" (the existing `RevisitList`). The full `PatientReview` component requires a loaded `ReviewState`; we keep this wrapper lightweight by navigating to the patient route rather than embedding PatientReview inline.

- [ ] **Step 1: Write PhaseValidate**

```tsx
// app/client/src/ui/Workspace/PhaseValidate.tsx
import { useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import { RevisitList } from "../PilotsTab/RevisitList";
import { authFetch } from "../../auth";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

interface PatientStatus {
  patient_id: string;
  agent_done: boolean;
  oracle_done: boolean;
  in_progress: boolean;
}

interface PhaseValidateProps {
  taskId: string;
  /** Active pilot iter id — required for RevisitList. */
  iterId: string;
  /** Navigate to the patient chart for validation. */
  onOpenPatient: (patientId: string) => void;
}

/**
 * VALIDATE phase — Patients sub-tab shows each patient chip with validation
 * status; clicking navigates to PatientReview. Revisits sub-tab shows the
 * existing RevisitList component.
 */
export function PhaseValidate({ taskId, iterId, onOpenPatient }: PhaseValidateProps) {
  const [patients, setPatients] = useState<PatientStatus[]>([]);
  const [tab, setTab] = useState<"patients" | "revisits">("patients");

  useEffect(() => {
    authFetch(`/api/pilots/${taskId}/${iterId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPatients(d?.patient_status ?? []))
      .catch(() => setPatients([]));
  }, [taskId, iterId]);

  const nextUnvalidated = patients.find((p) => p.agent_done && !p.oracle_done);

  return (
    <Tabs.Root value={tab} onValueChange={(v) => setTab(v as "patients" | "revisits")}>
      <Tabs.List className="flex gap-1 border-b border-border/60 pb-0">
        {(["patients", "revisits"] as const).map((t) => (
          <Tabs.Trigger
            key={t}
            value={t}
            className={cn(
              "px-4 py-2 text-[12px] uppercase tracking-[0.14em] transition-colors border-b-2 -mb-px",
              tab === t
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </Tabs.Trigger>
        ))}
      </Tabs.List>

      <Tabs.Content value="patients" className="pt-6">
        <div className="mb-4 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Validation progress · {patients.filter((p) => p.oracle_done).length} / {patients.length} patients
        </div>
        <div className="grid grid-cols-5 gap-2 mb-6">
          {patients.map((ps) => (
            <button
              key={ps.patient_id}
              type="button"
              onClick={() => onOpenPatient(ps.patient_id)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-[11px] transition-colors",
                ps.oracle_done
                  ? "border-[hsl(var(--sage))]/50 bg-[hsl(var(--sage))]/10 text-[hsl(var(--sage))]"
                  : ps.agent_done
                  ? "border-[hsl(var(--oxblood))]/40 bg-[hsl(var(--oxblood))]/5 text-foreground hover:bg-[hsl(var(--oxblood))]/10"
                  : "border-border bg-paper/30 text-muted-foreground",
              )}
            >
              <div className="truncate font-mono text-[10px]">{ps.patient_id}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {ps.oracle_done ? "validated" : ps.agent_done ? "ready" : "running…"}
              </div>
            </button>
          ))}
        </div>
        {nextUnvalidated && (
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => onOpenPatient(nextUnvalidated.patient_id)}
          >
            Validate next patient
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
        )}
      </Tabs.Content>

      <Tabs.Content value="revisits" className="pt-6">
        <RevisitList
          taskId={taskId}
          iterId={iterId}
          onReannotate={(patientId) => onOpenPatient(patientId)}
        />
      </Tabs.Content>
    </Tabs.Root>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd /path/to/chart-review-platform/app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Workspace/PhaseValidate|error TS" | head -20
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/Workspace/PhaseValidate.tsx
git commit -m "feat(workspace): add PhaseValidate wrapper with Patients/Revisits sub-tabs"
```

---

### Task 7: PhaseDecide wrapper

**Files:**
- Create: `app/client/src/ui/Workspace/PhaseDecide.tsx`

- [ ] **Step 1: Write PhaseDecide**

```tsx
// app/client/src/ui/Workspace/PhaseDecide.tsx
import { Button } from "@/components/ui/button";
import { ArrowRight, Lock, Pencil } from "lucide-react";
import type { CellCounts } from "./phase-logic";

interface PhaseDecideProps {
  versionTag: string | null;
  cells: CellCounts;
  /** Navigate the workspace to the DRAFT phase so the methodologist can edit criteria. */
  onRevise: () => void;
  /** Trigger the lock transition — caller handles the API call + maturity state update. */
  onLock: () => void;
  /** True when every cell is fresh (stale === 0 and validated === total). Lock is only
   *  enabled when this is true. */
  canLock: boolean;
}

/**
 * DECIDE phase — shows validation summary and exposes two equally-weighted CTAs:
 * "Revise" (back to DRAFT with a new version) and "Lock" (advance to LOCK phase).
 * The Lock button is disabled when any cell is stale or unvalidated.
 */
export function PhaseDecide({
  versionTag,
  cells,
  onRevise,
  onLock,
  canLock,
}: PhaseDecideProps) {
  const staleCount = cells.stale;
  const unvalidated = cells.total - cells.validated;

  return (
    <div className="mx-auto max-w-[640px] space-y-8 py-8">
      {/* Summary */}
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Validation summary{versionTag ? ` · ${versionTag}` : ""}
        </div>
        <h2
          className="mt-2 font-display text-[28px] tracking-tight"
          style={{ fontVariationSettings: '"opsz" 28, "SOFT" 50' }}
        >
          {cells.validated} of {cells.total} cells validated
        </h2>
        {staleCount > 0 && (
          <p className="mt-2 text-[13px] text-[hsl(var(--ochre))]">
            {staleCount} stale {staleCount === 1 ? "cell" : "cells"} — criteria changed since last validation.
          </p>
        )}
        {unvalidated > 0 && staleCount === 0 && (
          <p className="mt-2 text-[13px] text-muted-foreground">
            {unvalidated} {unvalidated === 1 ? "cell" : "cells"} not yet validated.
          </p>
        )}
        {canLock && (
          <p className="mt-2 text-[13px] text-[hsl(var(--sage))]">
            All cells are fresh and validated. Ready to lock.
          </p>
        )}
      </div>

      {/* Lock gate explanation */}
      {!canLock && (
        <div className="rounded-md border border-[hsl(var(--ochre))]/30 bg-[hsl(var(--ochre))]/5 px-4 py-3 text-[12.5px] text-[hsl(var(--ochre))]">
          <strong>Lock requires every cell to be fresh.</strong> Resolve stale cells or
          finish validation before locking. Alternatively, revise the rubric to start
          a new version.
        </div>
      )}

      {/* Dual CTAs — equal weight */}
      <div className="grid grid-cols-2 gap-4">
        <Button
          variant="outline"
          size="lg"
          className="h-16 flex-col gap-1"
          onClick={onRevise}
        >
          <Pencil size={16} />
          <span>Revise</span>
          <span className="text-[10px] font-normal text-muted-foreground">Start a new version</span>
        </Button>
        <Button
          variant="default"
          size="lg"
          className="h-16 flex-col gap-1"
          disabled={!canLock}
          onClick={onLock}
        >
          <Lock size={16} />
          <span>Lock</span>
          <span className="text-[10px] font-normal opacity-70">Freeze this version</span>
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd /path/to/chart-review-platform/app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Workspace/PhaseDecide|error TS" | head -20
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/Workspace/PhaseDecide.tsx
git commit -m "feat(workspace): add PhaseDecide wrapper with dual Revise/Lock CTAs"
```

---

### Task 8: Export Studio figures, then add PhaseLock and PhaseDeploy wrappers

`CalibrationFigure`, `RulesFigure`, `MethodsFigure`, and `BundlesFigure` currently live in `Studio.tsx` as unexported functions. PhaseLock needs to import them. This task exports them from Studio and then writes the two wrappers.

**Files:**
- Modify: `app/client/src/ui/Studio.tsx` (add `export` to the four figure functions)
- Create: `app/client/src/ui/Workspace/PhaseLock.tsx`
- Create: `app/client/src/ui/Workspace/PhaseDeploy.tsx`

- [ ] **Step 1: Export the four figure functions from Studio.tsx**

In `app/client/src/ui/Studio.tsx`, add the `export` keyword to each of the four functions. The exact lines to change:

Change `function CalibrationFigure(` → `export function CalibrationFigure(`

Change `function RulesFigure(` → `export function RulesFigure(`

Change `function MethodsFigure(` → `export function MethodsFigure(`

Change `function BundlesFigure(` → `export function BundlesFigure(`

- [ ] **Step 2: Verify the exports compile**

```bash
cd /path/to/chart-review-platform/app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep "Studio.tsx" | head -10
```

Expected: No errors on Studio.tsx

- [ ] **Step 3: Write PhaseLock**

```tsx
// app/client/src/ui/Workspace/PhaseLock.tsx
import { useState } from "react";
import { CalibrationFigure, RulesFigure, MethodsFigure, BundlesFigure } from "../Studio";
import { cn } from "@/lib/utils";
import { CheckSquare, Square } from "lucide-react";

interface PhaseLockProps {
  taskId: string;
  reviewerId: string;
  isMethodologist: boolean;
}

type LockStep = "calibration" | "rules" | "methods" | "bundles";

const STEPS: Array<{ id: LockStep; label: string; description: string }> = [
  { id: "calibration", label: "Run calibration (κ)", description: "Measure inter-rater agreement — overall κ ≥ 0.6 required." },
  { id: "rules", label: "Drain rule queue", description: "Accept or reject all pending rule proposals." },
  { id: "methods", label: "Draft methods section", description: "Generate the manuscript methods section from the locked rubric." },
  { id: "bundles", label: "Export reproducibility bundle", description: "Package everything for the collaborator handoff." },
];

/**
 * LOCK phase — presents the four lock prerequisites as a sequential checklist.
 * Each step expands to show the corresponding existing figure from Studio.
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
  );
}
```

- [ ] **Step 4: Write PhaseDeploy**

```tsx
// app/client/src/ui/Workspace/PhaseDeploy.tsx
import { CohortsFigure } from "../CohortsTab";

/**
 * DEPLOY phase — thin wrapper around the existing CohortsFigure.
 * CohortsFigure manages its own task-id-less endpoint (GET /api/cohorts)
 * so no taskId prop is needed here.
 */
export function PhaseDeploy() {
  return <CohortsFigure />;
}
```

- [ ] **Step 5: Type-check all three**

```bash
cd /path/to/chart-review-platform/app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Workspace/PhaseLock|Workspace/PhaseDeploy|Studio.tsx|error TS" | head -20
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/Studio.tsx app/client/src/ui/Workspace/PhaseLock.tsx app/client/src/ui/Workspace/PhaseDeploy.tsx
git commit -m "feat(workspace): export Studio figures; add PhaseLock checklist and PhaseDeploy wrappers"
```

---

### Task 9: ShowAllToolsToggle component

**Files:**
- Create: `app/client/src/ui/Workspace/ShowAllToolsToggle.tsx`

- [ ] **Step 1: Write the component**

```tsx
// app/client/src/ui/Workspace/ShowAllToolsToggle.tsx
import { useState, useEffect } from "react";
import { Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY_PREFIX = "workspace-show-all-tools:";

interface ShowAllToolsToggleProps {
  taskId: string;
  onChange: (enabled: boolean) => void;
}

/**
 * Small icon-only toggle in the top-right of the Workspace. When on:
 * - The pill bar becomes freely clickable (freeNav = true).
 * - A secondary nav row appears listing legacy tabs.
 * State persists per-task in localStorage.
 */
export function ShowAllToolsToggle({ taskId, onChange }: ShowAllToolsToggleProps) {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`${STORAGE_KEY_PREFIX}${taskId}`) === "1";
    } catch {
      return false;
    }
  });

  // Sync to parent and localStorage whenever the value changes.
  useEffect(() => {
    onChange(enabled);
    try {
      localStorage.setItem(`${STORAGE_KEY_PREFIX}${taskId}`, enabled ? "1" : "0");
    } catch {
      /* ignore — storage full */
    }
  }, [enabled, taskId, onChange]);

  return (
    <button
      type="button"
      onClick={() => setEnabled((v) => !v)}
      title={enabled ? "Hide legacy tabs" : "Show all tools"}
      aria-pressed={enabled}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
        enabled
          ? "border-foreground/40 bg-foreground/10 text-foreground"
          : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      <Wrench size={13} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd /path/to/chart-review-platform/app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Workspace/ShowAllToolsToggle|error TS" | head -20
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/Workspace/ShowAllToolsToggle.tsx
git commit -m "feat(workspace): add ShowAllToolsToggle with localStorage persistence"
```

---

### Task 10: Workspace top-level component

**Files:**
- Create: `app/client/src/ui/Workspace/index.tsx`

This component fetches its own data (maturity, pilots, iter detail, revisits, cohorts) using existing endpoints — mirroring the pattern in `WorkflowStatusBanner`. It computes `PhaseInfo` via `derivePhase`, renders the pill bar + headline + active phase wrapper + CTA footer. It also renders the "Show all tools" secondary nav row when the toggle is on.

- [ ] **Step 1: Write the component**

```tsx
// app/client/src/ui/Workspace/index.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../../auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import {
  derivePhase,
  deriveNextCTA,
  PHASE_ORDER as _PO,
  type Phase,
  type CellCounts,
  type MaturityState,
} from "./phase-logic";
import { PHASE_ORDER, PhasePillBar } from "./PhasePillBar";
import { PhaseHeadline } from "./PhaseHeadline";
import { ShowAllToolsToggle } from "./ShowAllToolsToggle";
import { PhaseDraft } from "./PhaseDraft";
import { PhaseTry } from "./PhaseTry";
import { PhaseValidate } from "./PhaseValidate";
import { PhaseDecide } from "./PhaseDecide";
import { PhaseLock } from "./PhaseLock";
import { PhaseDeploy } from "./PhaseDeploy";

// Legacy-tabs secondary nav — only shown in "Show all tools" mode.
// These are the tabs that do not have a dedicated phase home in the new shell.
const LEGACY_TABS: Array<{ id: string; label: string }> = [
  { id: "issues", label: "Issues" },
  { id: "rules", label: "Rules" },
  { id: "methods", label: "Methods" },
  { id: "bundles", label: "Bundles" },
];

// ── Data shapes mirrored from WorkflowStatusBanner ───────────────────────────

interface PilotIterListing {
  iter_id: string;
  iter_num: number;
  state: "running" | "ready_to_validate" | "complete" | "abandoned";
}

interface PilotIterDetail {
  patient_status: Array<{ patient_id: string; oracle_done: boolean; agent_done: boolean }>;
}

interface RevisitsResponse {
  ok: boolean;
  total?: number;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface WorkspaceProps {
  taskId: string;
  tasks: Array<{
    id: string;
    field_count: number;
    task_type?: string;
    manual_version?: string;
  }>;
  onTaskChange: (taskId: string) => void;
  reviewerId: string;
  isMethodologist: boolean;
  onEditGuideline?: (maturityState: string | null) => void;
  onOpenPatient?: (patientId: string, fieldId?: string) => void;
  /** Legacy sub-tab forwarded for "Show all tools" free-nav. */
  tab?: string;
  onTabChange?: (tab: string) => void;
}

// ── Workspace ─────────────────────────────────────────────────────────────────

export function Workspace({
  taskId,
  tasks,
  reviewerId,
  isMethodologist,
  onEditGuideline,
  onOpenPatient,
}: WorkspaceProps) {
  const [maturity, setMaturity] = useState<MaturityState>("draft");
  const [pilots, setPilots] = useState<PilotIterListing[]>([]);
  const [iterDetail, setIterDetail] = useState<PilotIterDetail | null>(null);
  const [revisitsTotal, setRevisitsTotal] = useState(0);
  const [deployedCohortExists, setDeployedCohortExists] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);
  const [manualPhaseOverride, setManualPhaseOverride] = useState<Phase | null>(null);

  const task = tasks.find((t) => t.id === taskId);
  const versionTag = task?.manual_version ? `v${task.manual_version}` : null;
  const criterionCount = task?.field_count ?? 1;

  // ── Data fetching ─────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    const [mat, pilotList] = await Promise.all([
      authFetch(`/api/guidelines/${encodeURIComponent(taskId)}/maturity`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      authFetch(`/api/pilots/${encodeURIComponent(taskId)}`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [] as PilotIterListing[]),
    ]);
    setMaturity((mat?.state as MaturityState) ?? "draft");
    setPilots(pilotList ?? []);

    const activeIter = pickActiveIter(pilotList ?? []);
    if (!activeIter) {
      setIterDetail(null);
      setRevisitsTotal(0);
      return;
    }
    const [detail, revisits] = await Promise.all([
      authFetch(`/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(activeIter.iter_id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      authFetch(`/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(activeIter.iter_id)}/revisits`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null) as Promise<RevisitsResponse | null>,
    ]);
    setIterDetail(detail);
    setRevisitsTotal(revisits?.total ?? 0);
  }, [taskId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Check if any cohort run exists (for DEPLOY phase detection).
  useEffect(() => {
    authFetch("/api/cohorts")
      .then((r) => (r.ok ? r.json() : { cohorts: [] }))
      .then((body) => setDeployedCohortExists((body.cohorts ?? []).length > 0))
      .catch(() => setDeployedCohortExists(false));
  }, [taskId]);

  // ── Phase derivation ──────────────────────────────────────────────────────

  const activeIter = useMemo(() => pickActiveIter(pilots), [pilots]);

  const cells = useMemo((): CellCounts => {
    const total = (iterDetail?.patient_status.length ?? 0) * Math.max(criterionCount, 1);
    const validated = (iterDetail?.patient_status.filter((p) => p.oracle_done).length ?? 0) * Math.max(criterionCount, 1);
    return { validated, total: Math.max(total, validated), stale: revisitsTotal };
  }, [iterDetail, criterionCount, revisitsTotal]);

  const phaseInfo = useMemo(
    () =>
      derivePhase(
        maturity,
        activeIter ?? null,
        cells,
        deployedCohortExists,
      ),
    [maturity, activeIter, cells, deployedCohortExists],
  );

  const activePhase: Phase = manualPhaseOverride ?? phaseInfo.phase;

  const donePhases = useMemo((): Phase[] => {
    const idx = PHASE_ORDER.indexOf(phaseInfo.phase);
    return PHASE_ORDER.slice(0, idx) as Phase[];
  }, [phaseInfo.phase]);

  const cta = useMemo(
    () => deriveNextCTA(activePhase, phaseInfo.status_label, cells),
    [activePhase, phaseInfo.status_label, cells],
  );

  // ── CTA handler ───────────────────────────────────────────────────────────

  function handleCTA() {
    switch (cta.action) {
      case "open-draft":
        onEditGuideline?.(maturity);
        break;
      case "run-agent":
        setManualPhaseOverride("TRY");
        break;
      case "open-validate":
      case "advance-decide":
        setManualPhaseOverride(
          cta.action === "advance-decide" ? "DECIDE" : "VALIDATE",
        );
        break;
      case "revise":
        setManualPhaseOverride("DRAFT");
        onEditGuideline?.(maturity);
        break;
      case "lock":
        setManualPhaseOverride("LOCK");
        break;
      case "run-calibration":
      case "run-lock-test":
      case "lock-version":
        setManualPhaseOverride("LOCK");
        break;
      case "run-cohort":
        setManualPhaseOverride("DEPLOY");
        break;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-[1240px] animate-rise-in space-y-0">
      {/* Top bar: pill bar + toggle */}
      <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-2">
        <PhasePillBar
          activePhase={activePhase}
          donePhases={donePhases}
          freeNav={showAllTools}
          onPhaseClick={(phase) => setManualPhaseOverride(phase)}
        />
        <ShowAllToolsToggle taskId={taskId} onChange={setShowAllTools} />
      </div>

      {/* Phase headline */}
      <div className="pt-3 pb-1">
        <PhaseHeadline phaseInfo={{ ...phaseInfo, phase: activePhase }} versionTag={versionTag} />
      </div>

      {/* Legacy secondary nav — only when Show all tools is on */}
      {showAllTools && (
        <nav
          aria-label="Legacy tabs"
          className="flex gap-1 border-b border-border/40 pb-2 animate-fade-in"
        >
          {LEGACY_TABS.map((lt) => (
            <button
              key={lt.id}
              type="button"
              onClick={() => {
                // Map to nearest phase equivalent or just show LOCK (which contains them)
                setManualPhaseOverride("LOCK");
              }}
              className="rounded-md border border-border px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground uppercase tracking-[0.12em]"
            >
              {lt.label}
            </button>
          ))}
        </nav>
      )}

      {/* Active phase surface */}
      <main className="min-h-[400px] py-6">
        {activePhase === "DRAFT" && (
          <PhaseDraft taskId={taskId} onEdit={onEditGuideline} />
        )}
        {activePhase === "TRY" && (
          <PhaseTry
            taskId={taskId}
            hasAnyIter={pilots.length > 0}
            onOpenPatient={onOpenPatient}
          />
        )}
        {activePhase === "VALIDATE" && activeIter && (
          <PhaseValidate
            taskId={taskId}
            iterId={activeIter.iter_id}
            onOpenPatient={(pid) => onOpenPatient?.(pid)}
          />
        )}
        {activePhase === "VALIDATE" && !activeIter && (
          <div className="text-[13px] text-muted-foreground">
            No active iteration to validate. Start an agent run in the TRY phase first.
          </div>
        )}
        {activePhase === "DECIDE" && (
          <PhaseDecide
            versionTag={versionTag}
            cells={cells}
            canLock={cells.stale === 0 && cells.validated >= cells.total && cells.total > 0}
            onRevise={() => {
              setManualPhaseOverride("DRAFT");
              onEditGuideline?.(maturity);
            }}
            onLock={() => setManualPhaseOverride("LOCK")}
          />
        )}
        {activePhase === "LOCK" && (
          <PhaseLock
            taskId={taskId}
            reviewerId={reviewerId}
            isMethodologist={isMethodologist}
          />
        )}
        {activePhase === "DEPLOY" && <PhaseDeploy />}
      </main>

      {/* Primary CTA footer — not shown in DECIDE (it has its own dual CTAs) */}
      {activePhase !== "DECIDE" && (
        <footer className="sticky bottom-0 border-t border-border/60 bg-background/80 backdrop-blur-sm py-3 flex justify-end">
          <Button size="sm" className="gap-1.5" onClick={handleCTA}>
            {cta.label}
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
        </footer>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickActiveIter(pilots: PilotIterListing[]): PilotIterListing | null {
  const candidates = pilots.filter((p) => p.state !== "abandoned");
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b.iter_num - a.iter_num)[0];
}
```

- [ ] **Step 2: Type-check**

```bash
cd /path/to/chart-review-platform/app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Workspace/index|error TS" | head -30
```

Expected: No errors

- [ ] **Step 3: Run all existing tests to confirm no regressions**

```bash
cd /path/to/chart-review-platform/app && npx vitest run 2>&1 | tail -20
```

Expected: All tests PASS (no regressions)

- [ ] **Step 4: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/Workspace/index.tsx
git commit -m "feat(workspace): add Workspace top-level component composing all phase wrappers"
```

---

### Task 11: Wire Workspace into App.tsx routing

**Files:**
- Modify: `app/client/src/ui/App.tsx`

- [ ] **Step 1: Add the Workspace import and swap the Studio render**

In `app/client/src/ui/App.tsx`:

1. Add import after the `Studio` import line:

```typescript
import { Workspace } from "./Workspace";
```

2. Replace the entire `{route.page === "studio" && task && ( <Studio … /> )}` block (lines 312–337) with:

```tsx
{route.page === "studio" && task && (
  <Workspace
    taskId={task.task_id}
    tasks={tasks.map((t) => ({
      id: t.task_id,
      field_count: t.field_count,
      task_type: t.task_type,
      manual_version: t.manual_version,
    }))}
    onTaskChange={selectGuideline}
    tab={route.subTab}
    onTabChange={(nextTab) => navigate(studioHash(task.task_id, nextTab))}
    reviewerId={reviewer ?? "anonymous"}
    isMethodologist={authInfo?.is_methodologist === true}
    onEditGuideline={() => {
      navigate(builderHash(task.task_id));
    }}
    onOpenPatient={(pid) => navigate(patientHash(task.task_id, pid))}
  />
)}
```

3. The `Studio` import can remain (it is still exported and imported by PhaseLock). Do NOT remove it.

- [ ] **Step 2: Type-check App.tsx**

```bash
cd /path/to/chart-review-platform/app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "App.tsx|error TS" | head -20
```

Expected: No errors

- [ ] **Step 3: Run all tests**

```bash
cd /path/to/chart-review-platform/app && npx vitest run 2>&1 | tail -20
```

Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git branch --show-current  # must print: feat/phase-driven-workspace
git add app/client/src/ui/App.tsx
git commit -m "feat(workspace): replace Studio with Workspace in App.tsx routing"
```

---

## Self-Review

### 1. Spec coverage

| Spec requirement | Task that covers it |
|---|---|
| Phase pill bar with done/active/future glyphs | Task 3 (`PhasePillBar`) |
| Phase headline with version + counts | Task 4 (`PhaseHeadline`) |
| Single primary CTA per phase | Tasks 10 footer + 2 (`deriveNextCTA`) |
| DRAFT phase wraps GuidelineFigure | Task 5 (`PhaseDraft`) |
| TRY phase wraps PilotsFigure | Task 5 (`PhaseTry`) |
| VALIDATE phase — Patients + Revisits sub-tabs | Task 6 (`PhaseValidate`) |
| DECIDE phase — dual Revise/Lock CTAs | Task 7 (`PhaseDecide`) |
| LOCK phase — sequential checklist wrapping existing figures | Task 8 (`PhaseLock`) |
| DEPLOY phase wraps CohortsFigure | Task 8 (`PhaseDeploy`) |
| "Show all tools" toggle — persisted per-task in localStorage | Task 9 (`ShowAllToolsToggle`) |
| Pill bar clickable in free-nav mode | Tasks 3 + 10 (`freeNav` prop) |
| Secondary nav row for legacy tabs in free-nav mode | Task 10 (`Workspace` legacy nav) |
| `derivePhase` pure function — 8 rules | Task 1 |
| `deriveNextCTA` pure function | Task 2 |
| App.tsx routing change | Task 11 |
| No `PilotManifest` rename, no new server endpoints | Plan A scope — not touched |
| Back-compat `#/studio/<taskId>` URL | Task 11 — same route key, different component |
| Cell counts from existing endpoints | Task 10 data fetching |

All spec requirements covered.

### 2. Placeholder scan

No "TODO", "TBD", "fill in", or "implement later" strings in any code block. All code is complete.

### 3. Type consistency

- `Phase` type defined once in `phase-logic.ts`; imported by every consumer.
- `CellCounts` defined once in `phase-logic.ts`; used identically in Task 1 tests, Task 2 tests, Task 7 `PhaseDecide`, and Task 10 `Workspace`.
- `CTAAction` and `CTADescriptor` defined in Task 2; used in Task 10 `handleCTA` switch.
- `PhaseInfo` defined in Task 1; used in Task 4 `PhaseHeadline` and Task 10.
- `WorkspaceProps` includes `tab` and `onTabChange` (matching `StudioProps` shape) to avoid breaking App.tsx's call site shape check — even though Workspace doesn't use them internally yet.
- `PHASE_ORDER` is defined in `PhasePillBar.tsx` and re-imported in `Workspace/index.tsx` (the duplicate `_PO` import alias in Task 10 is present only for the type import; fix: import `PHASE_ORDER` directly from `PhasePillBar` — as shown in Task 10 imports).
- `pickActiveIter` is defined locally in `Workspace/index.tsx` (not imported from `WorkflowStatusBanner`) — acceptable since it is a two-line function and avoids cross-component coupling.

### 4. Path verification (at time of plan authoring)

All component paths verified by filesystem read:
- `app/client/src/ui/Studio.tsx` — exists; `CalibrationFigure`, `RulesFigure`, `MethodsFigure`, `BundlesFigure` are unexported functions — Task 8 exports them.
- `app/client/src/ui/App.tsx` — exists; `<Studio …/>` at `route.page === "studio"` block confirmed.
- `app/client/src/ui/GuidelineTab/index.tsx` — exists; exports `GuidelineFigure`.
- `app/client/src/ui/PatientReview.tsx` — exists; exports `PatientReview` + `PatientReviewProps`.
- `app/client/src/ui/PilotsTab/RevisitList.tsx` — exists; exports `RevisitList` + `RevisitListProps`.
- `app/client/src/ui/PilotsTab/IterDetail.tsx` — exists; exports `IterDetail` (used indirectly via `PilotsFigure`).
- `app/client/src/ui/PilotsTab/index.tsx` — exists; exports `PilotsFigure`.
- `app/client/src/ui/CohortsTab/index.tsx` — exists; exports `CohortsFigure`.
- `app/client/src/ui/IssuesTab/index.tsx` — exists; exports `IssuesFigure`.
- `app/client/src/ui/WorkflowStatusBanner.tsx` — exists; not referenced by Workspace (replaced by pill bar + headline).
- `app/tsconfig.json` — at `chart-review-platform/app/tsconfig.json`; test command is `npx vitest run`.
- No `CalibrationTab/`, `MethodsTab/`, or `BundlesTab/` standalone directories exist — these are figure functions inside `Studio.tsx`. Plan correctly exports them from Studio rather than creating standalone files.

---

## Execution Handoff

Plan complete and saved to `chart-review-platform/docs/superpowers/plans/2026-05-06-workspace-shell-plan-a.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review output between tasks, fast iteration. Use the `superpowers:subagent-driven-development` skill.

**2. Inline Execution** — Execute tasks in this session using the `superpowers:executing-plans` skill with batch execution and checkpoints.

Which approach?
