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
import { WorkspaceSettings } from "./WorkspaceSettings";
import { PhaseDraft } from "./PhaseDraft";
import { PhaseSpanAuthor } from "./PhaseSpanAuthor";
import { taskKindUi } from "./task-kind-registry";
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

// Three-state load tracker for the pilots fetch. Distinguishes "still
// loading" from "server returned but list is empty" from "fetch failed"
// — without this the JUDGE/VALIDATE empty-state mis-reports a transient
// dev-server restart as "no run yet". See [Workspace empty-state copy].
type PilotsState = "loading" | "error" | PilotIterListing[];

interface PilotIterDetail {
  patient_status: Array<{ patient_id: string; oracle_done: boolean; agent_done: boolean }>;
}

interface SpanStatsTotals {
  total: number;
  mapped: number;
  novel: number;
  rejected: number;
  validated: number;
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
  const [pilots, setPilots] = useState<PilotsState>("loading");
  const [iterDetail, setIterDetail] = useState<PilotIterDetail | null>(null);
  const [revisitsTotal, setRevisitsTotal] = useState(0);
  const [deployedCohortExists, setDeployedCohortExists] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);
  // NER span stats (Phase 4.4) — only fetched when task_kind=ner.
  // For phenotype tasks this stays null and the cells useMemo computes
  // from field_assessments × criterionCount as before.
  const [spanStats, setSpanStats] = useState<SpanStatsTotals | null>(null);

  // Per-task enabled phases — fetched from /api/tasks/:taskId/phases.
  // null until the fetch resolves (PhasePillBar treats null as "all enabled").
  const [enabledPhases, setEnabledPhases] = useState<Phase[] | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    authFetch(`/api/tasks/${encodeURIComponent(taskId)}/phases`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const ids: string[] = Array.isArray(d.enabled) ? d.enabled : [];
        // map "author" → "AUTHOR" etc.
        setEnabledPhases(ids.map((id) => id.toUpperCase() as Phase));
      })
      .catch(() => { /* fall back to all phases */ });
    return () => { cancelled = true; };
  }, [taskId]);

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
    // Cohort selection differs by task_kind:
    //   - phenotype: per-patient validation (oracle_done flag) — gate on
    //     "patient marked validated"
    //   - NER: per-note validation (validated_notes[] inside review_state).
    //     Hand the driver every patient with a review_state.json; the
    //     server-side driver filters by validated_notes internally and
    //     only clusters spans inside validated notes. Gate on "at least
    //     one note validated across the cohort" via spanStats.
    let cohortPids: string[] = [];
    const isNer = task?.task_type === "ner";
    if (isNer) {
      cohortPids = (iterDetail?.patient_status ?? [])
        .filter((p) => p.agent_done)
        .map((p) => p.patient_id);
      const totalsValidated = spanStats?.validated ?? 0;
      if (totalsValidated === 0) {
        alert(
          "No notes validated yet — validate at least one note before "
          + "running improvement (the driver clusters only spans inside "
          + "validated notes).",
        );
        return;
      }
    } else {
      cohortPids = (iterDetail?.patient_status ?? [])
        .filter((p) => p.oracle_done)
        .map((p) => p.patient_id);
      if (cohortPids.length === 0) {
        alert("No validated patients yet — finish validating before running improvement.");
        return;
      }
    }
    setIsImproving(true);
    setImproveProposalCount(undefined);
    try {
      const r = await authFetch(`/api/guideline-improvement/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patient_ids: cohortPids }),
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
    const [mat, pilotsResult] = await Promise.all([
      authFetch(`/api/guidelines/${encodeURIComponent(taskId)}/maturity`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      authFetch(`/api/pilots/${encodeURIComponent(taskId)}`)
        .then(async (r): Promise<PilotsState> =>
          r.ok ? ((await r.json()) as PilotIterListing[]) : "error",
        )
        .catch((): PilotsState => "error"),
    ]);
    setMaturity((mat?.state as MaturityState) ?? "draft");
    setPilots(pilotsResult);

    const pilotList = Array.isArray(pilotsResult) ? pilotsResult : [];
    const activeIter = pickActiveIter(pilotList);
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

  // NER span stats — fetched only when task_kind=ner and an active iter
  // exists. Phenotype tasks leave `spanStats=null` so the cells useMemo
  // falls back to its existing field_assessments × criterionCount math.
  const isNerTask = task?.task_type === "ner";
  const activeIterId = Array.isArray(pilots)
    ? pickActiveIter(pilots)?.iter_id ?? null
    : null;
  useEffect(() => {
    if (!isNerTask || !activeIterId) { setSpanStats(null); return; }
    let cancelled = false;
    authFetch(`/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(activeIterId)}/span-stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { totals?: SpanStatsTotals } | null) => {
        if (cancelled || !d) return;
        if (d.totals) setSpanStats(d.totals);
      })
      .catch(() => { if (!cancelled) setSpanStats(null); });
    return () => { cancelled = true; };
  }, [isNerTask, activeIterId, taskId]);

  // ── Phase derivation ──────────────────────────────────────────────────────

  const activeIter = useMemo(
    () => (Array.isArray(pilots) ? pickActiveIter(pilots) : null),
    [pilots],
  );

  const cells = useMemo((): CellCounts => {
    const patientCount = iterDetail?.patient_status.length ?? 0;
    // NER tasks use the span-stats totals; phenotype tasks use the
    // historical field_assessments × criterionCount derivation.
    if (isNerTask && spanStats) {
      return {
        validated: spanStats.validated,
        total: Math.max(spanStats.total, spanStats.validated),
        stale: revisitsTotal,
        patient_count: patientCount,
      };
    }
    const total = patientCount * Math.max(criterionCount, 1);
    const validated = (iterDetail?.patient_status.filter((p) => p.oracle_done).length ?? 0) * Math.max(criterionCount, 1);
    return {
      validated,
      total: Math.max(total, validated),
      stale: revisitsTotal,
      patient_count: patientCount,
    };
  }, [iterDetail, criterionCount, revisitsTotal, isNerTask, spanStats]);

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
          enabledPhases={enabledPhases ?? undefined}
        />
        <WorkspaceSettings taskId={taskId} onShowAllToolsChange={setShowAllTools} />
      </div>

      {/* Phase headline */}
      <div className="pt-3 pb-1">
        <PhaseHeadline phaseInfo={{ ...phaseInfo, phase: activePhase }} versionTag={versionTag} taskKind={isNerTask ? "ner" : "phenotype"} />
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
          task?.task_type === "ner" ? (
            <PhaseSpanAuthor
              taskId={taskId}
              canEdit={isMethodologist}
            />
          ) : (
            <PhaseDraft
              taskId={taskId}
              onPreflightHasErrors={setPreflightHasErrors}
            />
          )
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
            taskKind={task?.task_type === "ner" ? "ner" : "phenotype"}
            onOpenSpan={(pid) => onOpenPatient?.(pid)}
          />
        )}
        {activePhase === "JUDGE" && !activeIter && (
          <PilotsEmptyState pilots={pilots} verb="judge" onRetry={refresh} />
        )}
        {activePhase === "VALIDATE" && activeIter && (
          <PhaseValidate
            taskId={taskId}
            iterId={activeIter.iter_id}
            onOpenPatient={(pid) => onOpenPatient?.(pid)}
            taskKind={task?.task_type === "ner" ? "ner" : "phenotype"}
          />
        )}
        {activePhase === "VALIDATE" && !activeIter && (
          <PilotsEmptyState pilots={pilots} verb="validate" onRetry={refresh} />
        )}
        {activePhase === "DECIDE" && (
          <PhaseDecide
            taskId={taskId}
            versionTag={versionTag}
            cells={cells}
            patientIds={iterDetail?.patient_status.map((p) => p.patient_id) ?? []}
            canLock={cells.stale === 0 && cells.validated >= cells.total && cells.total > 0}
            taskKind={isNerTask ? "ner" : "phenotype"}
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
            taskKind={isNerTask ? "ner" : "phenotype"}
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
      ) : activePhase !== "DECIDE" && activePhase !== "TRY" && activePhase !== "VALIDATE" && activePhase !== "LOCK" ? (
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

function PilotsEmptyState({
  pilots, verb, onRetry,
}: {
  pilots: PilotsState;
  verb: "judge" | "validate";
  onRetry: () => void;
}) {
  if (pilots === "loading") {
    return <div className="text-[13px] text-muted-foreground">Loading…</div>;
  }
  if (pilots === "error") {
    return (
      <div className="space-y-2">
        <div className="text-[13px] text-[hsl(var(--oxblood))]">
          Couldn't load pilots list. The dev server may have just restarted.
        </div>
        <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  return (
    <div className="text-[13px] text-muted-foreground">
      No active iteration to {verb}. Start an agent run in the TRY phase first.
    </div>
  );
}
