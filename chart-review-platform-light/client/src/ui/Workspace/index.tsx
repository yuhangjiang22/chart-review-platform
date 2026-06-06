import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";
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
import { taskKindFromTaskType } from "./task-kind-registry";
import { PhaseTry } from "./PhaseTry";
import { PhaseValidate } from "./PhaseValidate";
import { PhaseDecide } from "./PhaseDecide";
import { SessionSwitcher, type SessionListItem } from "./SessionSwitcher";
import { NewSessionDialog } from "./NewSessionDialog";
import { SessionSidebar } from "./SessionSidebar";

// ── Data shapes mirrored from WorkflowStatusBanner ───────────────────────────

interface PilotIterListing {
  iter_id: string;
  iter_num: number;
  state: "running" | "ready_to_validate" | "complete" | "abandoned";
  /** Session this iter belongs to. Absent on legacy/pre-session iters. */
  session_id?: string;
}

// Three-state load tracker for the pilots fetch. Distinguishes "still
// loading" from "server returned but list is empty" from "fetch failed"
// — without this the VALIDATE empty-state mis-reports a transient
// dev-server restart as "no run yet". See [Workspace empty-state copy].
type PilotsState = "loading" | "error" | PilotIterListing[];

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
  reviewerId: _reviewerId,
  isMethodologist,
  onEditGuideline: _onEditGuideline,
  onOpenPatient,
  tab,
  onTabChange,
}: WorkspaceProps) {
  const [maturity, setMaturity] = useState<MaturityState>("draft");
  const [pilots, setPilots] = useState<PilotsState>("loading");
  const [iterDetail, setIterDetail] = useState<PilotIterDetail | null>(null);
  const [revisitsTotal, setRevisitsTotal] = useState(0);

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
        // map slug → Phase ID ("try" → "TRY", etc.)
        setEnabledPhases(ids.map((id) => id.toUpperCase() as Phase));
      })
      .catch(() => { /* fall back to all phases */ });
    return () => { cancelled = true; };
  }, [taskId]);

  // Phase override is now URL-driven via the `tab` prop. When the URL has
  // /studio/<task>/<phase> (where phase is a key in PHASE_TABS), that phase
  // is the active one; otherwise we fall back to the auto-derived phase.
  // setPhase writes to the URL via onTabChange, so back/forward and refresh
  // all preserve the phase the reviewer was on.
  //
  // Guard: if the URL points at a phase that THIS task has disabled,
  // ignore the override so the pill bar's auto-derived active phase wins.
  // Otherwise the body renders a phase the pill bar can't show, leaving
  // the user with no visible "active" cue.
  const rawOverride: Phase | null = tab
    ? PHASE_TABS[tab.toLowerCase()] ?? null
    : null;
  const manualPhaseOverride: Phase | null =
    rawOverride && enabledPhases && !enabledPhases.includes(rawOverride)
      ? null
      : rawOverride;
  // Sync the URL back to a valid phase when the current one is disabled,
  // so refreshing or sharing the link doesn't keep landing on a hidden
  // phase. Runs once per task on first load of enabledPhases.
  useEffect(() => {
    if (!enabledPhases) return;
    if (rawOverride && !enabledPhases.includes(rawOverride)) {
      onTabChange?.("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledPhases, rawOverride]);

  const setPhase = (phase: Phase | null) => {
    onTabChange?.(phase ? phase.toLowerCase() : "");
  };

  // chart-review-improve runner. Posts to /api/guideline-improvement/:taskId
  // with the validated patient cohort.
  const [isImproving, setIsImproving] = useState(false);
  const [improveProposalCount, setImproveProposalCount] = useState<number | undefined>();
  const [improveRefreshKey, setImproveRefreshKey] = useState(0);
  // DECIDE → TRY inner loop: re-run the same cohort + agent_specs as the
  // active iter. Reviewer's persisted answers carry forward as the gold
  // standard, so the next iter scores automatically.
  const [isRunningAgain, setIsRunningAgain] = useState(false);

  // ── Sessions (fixed-cohort grouping above iters) ──────────────────────────
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const sessionStorageKey = `chart-review:active-session:${taskId}`;
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(() => {
    try { return localStorage.getItem(sessionStorageKey); } catch { return null; }
  });
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  function setActiveSessionId(sid: string | null) {
    setActiveSessionIdState(sid);
    try {
      if (sid) localStorage.setItem(sessionStorageKey, sid);
      else localStorage.removeItem(sessionStorageKey);
    } catch { /* ignore quota errors */ }
  }

  // Sidebar open/closed — persisted per session (so closing on a small
  // viewport doesn't blow it away on the next page load).
  const sidebarStorageKey = `chart-review:sidebar-open:${taskId}`;
  const [sidebarOpen, setSidebarOpenState] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(sidebarStorageKey);
      return v === null ? true : v === "1";
    } catch { return true; }
  });
  function setSidebarOpen(open: boolean) {
    setSidebarOpenState(open);
    try { localStorage.setItem(sidebarStorageKey, open ? "1" : "0"); }
    catch { /* ignore */ }
  }

  const refreshSessions = useCallback(async () => {
    const r = await authFetch(`/api/sessions/${encodeURIComponent(taskId)}`);
    if (!r.ok) return;
    const body = await r.json() as { sessions: SessionListItem[] };
    setSessions(body.sessions);
    // If active session no longer exists, fall back to the newest active.
    if (activeSessionId
        && !body.sessions.some((s) => s.session.session_id === activeSessionId)) {
      const firstActive = body.sessions.find((s) => s.session.state === "active");
      setActiveSessionId(firstActive?.session.session_id ?? null);
    }
  // activeSessionId intentionally excluded — refresh should not loop on its
  // own setState. Including it would re-run refresh after every session
  // switch and possibly clobber the user's manual selection mid-fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);

  async function runImprovement() {
    if (isImproving) return;
    // Phenotype: per-patient validation (oracle_done flag).
    let cohortPids: string[] = [];
    cohortPids = (iterDetail?.patient_status ?? [])
      .filter((p) => p.oracle_done)
      .map((p) => p.patient_id);
    if (cohortPids.length === 0) {
      alert("No validated patients yet — finish validating before running improvement.");
      return;
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

  // POST /api/pilots/:taskId/:iterId/run-again — kicks off a new iter on
  // the SAME cohort + agent_specs as the active iter. The server resolves
  // patient_ids + agent_specs from the prior run manifest, so the client
  // doesn't need to know them. After the new iter is born we refresh the
  // pilots list and jump back to TRY so the reviewer can watch the run.
  async function runAgain() {
    if (isRunningAgain) return;
    if (!Array.isArray(pilots) || pilots.length === 0) {
      alert("No prior iter to re-run.");
      return;
    }
    const active = pickActiveIter(pilots, activeSessionId);
    if (!active) {
      alert("No prior iter to re-run.");
      return;
    }
    setIsRunningAgain(true);
    try {
      const r = await authFetch(
        `/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(active.iter_id)}/run-again`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const bodyText = await r.text();
      if (!r.ok) {
        alert(`Re-run failed: ${bodyText}`);
        return;
      }
      await refresh();
      setPhase("TRY");
    } finally {
      setIsRunningAgain(false);
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
    const activeIter = pickActiveIter(pilotList, activeSessionId);
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
    void refresh();
  }, [refresh]);

  // Normalized discriminator used across every phase-pane prop +
  // dispatched component lookup. Mirrors the server's taskKindFromTaskType.
  const taskKind = taskKindFromTaskType(task?.task_type);
  const activeIterId = Array.isArray(pilots)
    ? pickActiveIter(pilots, activeSessionId)?.iter_id ?? null
    : null;

  // ── Phase derivation ──────────────────────────────────────────────────────

  const activeIter = useMemo(
    () => (Array.isArray(pilots) ? pickActiveIter(pilots, activeSessionId) : null),
    [pilots, activeSessionId],
  );

  const cells = useMemo((): CellCounts => {
    const patientCount = iterDetail?.patient_status.length ?? 0;
    // Phenotype: field_assessments × criterionCount derivation.
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
        false, // deployedCohortExists — no DEPLOY phase in light platform
      ),
    [maturity, activeIter, cells],
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
        setPhase("TRY");
        break;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Per-patient status keyed map for the sidebar — derived from
  // iterDetail's patient_status array (already loaded by refresh()).
  const sidebarPatientStatus: Record<string, { oracle_done: boolean; errored?: boolean }> = {};
  for (const ps of iterDetail?.patient_status ?? []) {
    sidebarPatientStatus[ps.patient_id] = {
      oracle_done: ps.oracle_done,
      errored: (ps as { errored?: boolean }).errored,
    };
  }
  const sessionIters = Array.isArray(pilots)
    ? pilots
        .filter((p) => activeSessionId && p.session_id === activeSessionId)
        .sort((a, b) => b.iter_num - a.iter_num)
        .map((p) => ({
          iter_id: p.iter_id, iter_num: p.iter_num, state: p.state,
          started_at: (p as { started_at?: string }).started_at ?? "",
        }))
    : [];

  return (
    <div className="flex gap-2 animate-rise-in">
      <div className="flex-1 min-w-0 max-w-[1240px] mx-auto space-y-0">
      {/* Top bar: pill bar + session switcher + toggle */}
      <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-2">
        <PhasePillBar
          activePhase={activePhase}
          donePhases={donePhases}
          maturity={maturity}
          onPhaseClick={(phase) => setPhase(phase)}
          enabledPhases={enabledPhases ?? undefined}
        />
        <div className="flex items-center gap-3">
          <SessionSwitcher
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={setActiveSessionId}
            onNewSession={() => setNewSessionOpen(true)}
          />
          <WorkspaceSettings taskId={taskId} onShowAllToolsChange={() => { /* show-all-tools not used in light platform */ }} />
        </div>
      </div>

      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        taskId={taskId}
        onCreated={async (sid) => {
          await refreshSessions();
          setActiveSessionId(sid);
        }}
      />

      {/* Phase headline */}
      <div className="pt-3 pb-1">
        <PhaseHeadline phaseInfo={{ ...phaseInfo, phase: activePhase }} versionTag={versionTag} taskKind={taskKind} />
      </div>

      {/* Active phase surface */}
      <main className="min-h-[400px] py-6">
        {/* No-session gate — every phase requires an active session. */}
        {!activeSessionId && (
          <div className="mx-auto max-w-[520px] py-12 space-y-4 text-center">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              No active session
            </div>
            <h3
              className="font-display text-[22px] tracking-tight"
              style={{ fontVariationSettings: '"opsz" 22, "SOFT" 50' }}
            >
              Pick or start a session to see this phase
            </h3>
            <p className="text-[13px] text-muted-foreground">
              Every iter — and the validation, scoring, and performance review
              that follow — lives inside a session. Without one, there's nothing
              to show here.
            </p>
            <Button onClick={() => setNewSessionOpen(true)} className="gap-1.5">
              Start new session
            </Button>
          </div>
        )}

        {activePhase === "TRY" && activeSessionId && (
          <PhaseTry
            taskId={taskId}
            onAdvanceToValidate={() => setPhase("VALIDATE")}
            activeSessionId={activeSessionId}
            onOpenNewSession={() => setNewSessionOpen(true)}
            taskKind={taskKind}
          />
        )}
        {activePhase === "VALIDATE" && activeSessionId && activeIter && (
          <PhaseValidate
            taskId={taskId}
            iterId={activeIter.iter_id}
            onOpenPatient={(pid) => onOpenPatient?.(pid)}
            taskKind={taskKind}
          />
        )}
        {activePhase === "VALIDATE" && activeSessionId && !activeIter && (
          <PilotsEmptyState pilots={pilots} verb="validate" onRetry={refresh} />
        )}
        {activePhase === "DECIDE" && activeSessionId && (
          <PhaseDecide
            taskId={taskId}
            iterId={activeIterId ?? undefined}
            versionTag={versionTag}
            cells={cells}
            patientIds={iterDetail?.patient_status.map((p) => p.patient_id) ?? []}
            canLock={cells.stale === 0 && cells.validated >= cells.total && cells.total > 0}
            taskKind={taskKind}
            onRevise={() => setPhase("TRY")}
            onLock={() => { /* no lock phase in light platform */ }}
            onImprove={runImprovement}
            isImproving={isImproving}
            improveProposalCount={improveProposalCount}
            improveRefreshKey={improveRefreshKey}
            onRunAgain={isMethodologist ? runAgain : undefined}
            isRunningAgain={isRunningAgain}
            activeSessionId={activeSessionId}
          />
        )}
      </main>
      </div>

      <SessionSidebar
        taskId={taskId}
        activeSessionId={activeSessionId}
        sessionIters={sessionIters}
        activeIterId={activeIterId}
        patientStatus={sidebarPatientStatus}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onJumpToAuthor={() => setPhase("TRY")}
        taskKind={taskKind}
      />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickActiveIter(
  pilots: PilotIterListing[],
  activeSessionId: string | null,
): PilotIterListing | null {
  // activeSessionId is REQUIRED — callers must pass null explicitly when
  // no session is selected, so they think about session scoping rather
  // than silently returning a cross-session iter. Previously this used
  // `arguments.length` to distinguish "no filter" from "null filter",
  // which was both ugly and exactly the trap that surfaced as the
  // "session 1 shows iter_010 from session_001" bug.
  if (!activeSessionId) return null;
  const candidates = pilots.filter(
    (p) => p.state !== "abandoned" && p.session_id === activeSessionId,
  );
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
