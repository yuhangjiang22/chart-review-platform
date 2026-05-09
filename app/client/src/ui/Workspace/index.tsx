import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import {
  derivePhase,
  deriveNextCTA,
  type Phase,
  type CellCounts,
  type MaturityState,
} from "./phase-logic";
import { PHASE_ORDER, PhasePillBar } from "./PhasePillBar";
import { PHASE_SLUG_TO_ID } from "./phases";
import { PhaseHeadline } from "./PhaseHeadline";
import { ShowAllToolsToggle } from "./ShowAllToolsToggle";
import { PhaseDraft } from "./PhaseDraft";
import { PhaseTry } from "./PhaseTry";
import { PhaseJudge } from "./PhaseJudge";
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

// Phase identifiers used as the studio sub-tab in the URL hash. Derived
// from phases.ts so adding a new phase is a one-file change. Lowercase
// to match the existing #/studio/<task>/<subTab> shape.
const PHASE_TABS: Record<string, Phase> = PHASE_SLUG_TO_ID;

export function Workspace({
  taskId,
  tasks,
  reviewerId,
  isMethodologist,
  onEditGuideline,
  onOpenPatient,
  tab,
  onTabChange,
}: WorkspaceProps) {
  const [maturity, setMaturity] = useState<MaturityState>("draft");
  const [pilots, setPilots] = useState<PilotIterListing[]>([]);
  const [iterDetail, setIterDetail] = useState<PilotIterDetail | null>(null);
  const [revisitsTotal, setRevisitsTotal] = useState(0);
  const [deployedCohortExists, setDeployedCohortExists] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);

  /** True when pre-flight reports error-level diagnostics in the AUTHOR phase. */
  const [preflightHasErrors, setPreflightHasErrors] = useState(false);

  // Phase override is now URL-driven via the `tab` prop. When the URL has
  // /studio/<task>/<phase> (where phase is a key in PHASE_TABS), that phase
  // is the active one; otherwise we fall back to the auto-derived phase.
  // setPhase writes to the URL via onTabChange, so back/forward and refresh
  // all preserve the phase the reviewer was on.
  const manualPhaseOverride: Phase | null = tab
    ? PHASE_TABS[tab.toLowerCase()] ?? null
    : null;

  const setPhase = (phase: Phase | null) => {
    onTabChange?.(phase ? phase.toLowerCase() : "");
  };

  // chart-review-improve runner. Posts to /api/guideline-improvement/:taskId
  // with the validated patient cohort.
  const [isImproving, setIsImproving] = useState(false);
  const [improveProposalCount, setImproveProposalCount] = useState<number | undefined>();
  const [improveRefreshKey, setImproveRefreshKey] = useState(0);
  async function runImprovement() {
    if (isImproving) return;
    const validatedPids = (iterDetail?.patient_status ?? [])
      .filter((p) => p.oracle_done)
      .map((p) => p.patient_id);
    if (validatedPids.length === 0) {
      alert("No validated patients yet — finish validating before running improvement.");
      return;
    }
    setIsImproving(true);
    setImproveProposalCount(undefined);
    try {
      const r = await authFetch(`/api/guideline-improvement/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patient_ids: validatedPids }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        alert(`Improvement failed: ${body.error ?? body.message ?? "unknown"}`);
        return;
      }
      setImproveProposalCount(
        typeof body.proposal_count === "number"
          ? body.proposal_count
          : Array.isArray(body.proposals)
            ? body.proposals.length
            : 0,
      );
      setImproveRefreshKey((k) => k + 1);
    } finally {
      setIsImproving(false);
    }
  }

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
    // Reset preflight state on task change so stale errors from a previous
    // task don't bleed into the newly selected task.
    setPreflightHasErrors(false);
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
    const patientCount = iterDetail?.patient_status.length ?? 0;
    const total = patientCount * Math.max(criterionCount, 1);
    const validated = (iterDetail?.patient_status.filter((p) => p.oracle_done).length ?? 0) * Math.max(criterionCount, 1);
    return {
      validated,
      total: Math.max(total, validated),
      stale: revisitsTotal,
      patient_count: patientCount,
    };
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
        setPhase("TRY");
        break;
      case "open-validate":
      case "advance-decide":
        setPhase(
          cta.action === "advance-decide" ? "DECIDE" : "VALIDATE",
        );
        break;
      case "revise":
        setPhase("AUTHOR");
        onEditGuideline?.(maturity);
        break;
      case "lock":
        setPhase("LOCK");
        break;
      case "run-calibration":
      case "run-lock-test":
      case "lock-version":
        setPhase("LOCK");
        break;
      case "run-cohort":
        setPhase("DEPLOY");
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
          onPhaseClick={(phase) => setPhase(phase)}
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
                setPhase("LOCK");
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
        {activePhase === "AUTHOR" && (
          <PhaseDraft
            taskId={taskId}
            onPreflightHasErrors={setPreflightHasErrors}
          />
        )}
        {activePhase === "TRY" && (
          <PhaseTry
            taskId={taskId}
            onAdvanceToValidate={() => setPhase("JUDGE")}
          />
        )}
        {activePhase === "JUDGE" && activeIter && (
          <PhaseJudge
            taskId={taskId}
            iterId={activeIter.iter_id}
            onSkipToValidate={() => setPhase("VALIDATE")}
          />
        )}
        {activePhase === "JUDGE" && !activeIter && (
          <div className="text-[13px] text-muted-foreground">
            No active iteration to judge. Start an agent run in the TRY phase first.
          </div>
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
            taskId={taskId}
            versionTag={versionTag}
            cells={cells}
            patientIds={iterDetail?.patient_status.map((p) => p.patient_id) ?? []}
            canLock={cells.stale === 0 && cells.validated >= cells.total && cells.total > 0}
            onRevise={() => {
              setPhase("AUTHOR");
              onEditGuideline?.(maturity);
            }}
            onLock={() => setPhase("LOCK")}
            onImprove={runImprovement}
            isImproving={isImproving}
            improveProposalCount={improveProposalCount}
            improveRefreshKey={improveRefreshKey}
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

      {/* CTA footer — AUTHOR has dual CTAs ("Edit guideline" + "Try on
       *  patients"). DECIDE and TRY render their actions inline (DECIDE has
       *  Revise + Lock; TRY has Stop / Override / Validate on the run card,
       *  or the form's own Run button). Other phases use the single derived
       *  CTA. */}
      {activePhase === "AUTHOR" ? (
        <footer className="sticky bottom-0 border-t border-border/60 bg-background/80 backdrop-blur-sm py-3 flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => onEditGuideline?.(maturity)}
          >
            Edit guideline
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={preflightHasErrors}
            title={
              preflightHasErrors
                ? "Resolve pre-flight diagnostics before running TRY"
                : undefined
            }
            onClick={() => !preflightHasErrors && setPhase("TRY")}
          >
            Try on patients
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
        </footer>
      ) : activePhase !== "DECIDE" && activePhase !== "TRY" && activePhase !== "VALIDATE" ? (
        <footer className="sticky bottom-0 border-t border-border/60 bg-background/80 backdrop-blur-sm py-3 flex justify-end">
          <Button size="sm" className="gap-1.5" onClick={handleCTA}>
            {cta.label}
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
        </footer>
      ) : null}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickActiveIter(pilots: PilotIterListing[]): PilotIterListing | null {
  const candidates = pilots.filter((p) => p.state !== "abandoned");
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b.iter_num - a.iter_num)[0];
}
