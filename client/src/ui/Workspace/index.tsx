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
import { RubricPanel } from "./RubricPanel";
import { RefineProposalCard } from "./RefineProposalCard";
import { RefineWorkspace } from "./RefineWorkspace";
import { AdherenceRubricPanel } from "./AdherenceRubricPanel";
import { PhaseValidate } from "./PhaseValidate";
import { PhaseJudge } from "./PhaseJudge";
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


  // ── Sessions (fixed-cohort grouping above iters) ──────────────────────────
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const sessionStorageKey = `chart-review:active-session:${taskId}`;
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(() => {
    try { return localStorage.getItem(sessionStorageKey); } catch { return null; }
  });
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  function setActiveSessionId(sid: string | null) {
    const changed = sid !== activeSessionId;
    setActiveSessionIdState(sid);
    try {
      if (sid) localStorage.setItem(sessionStorageKey, sid);
      else localStorage.removeItem(sessionStorageKey);
    } catch { /* ignore quota errors */ }
    // Switching sessions must drop the URL phase override so the phase
    // re-derives for the NEW session. Otherwise opening a fresh session while
    // on DECIDE keeps you on DECIDE (performance) instead of TRY — a fresh
    // session has no iters, which derives to TRY.
    if (changed) {
      try { onTabChange?.(""); } catch { /* no-op */ }
    }
    // App.tsx mirrors the active session from localStorage for the patient-review
    // surface; notify it so a mid-task session switch isn't read stale.
    try {
      window.dispatchEvent(
        new CustomEvent("chart-review:session-changed", { detail: { taskId, sessionId: sid } }),
      );
    } catch { /* no window (tests) */ }
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
    const body = await r.json() as { sessions: SessionListItem[] } | null;
    if (!body?.sessions) return;
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

  const archiveSession = useCallback(async (sessionId: string) => {
    const r = await authFetch(
      `/api/sessions/${encodeURIComponent(taskId)}/${encodeURIComponent(sessionId)}/archive`,
      { method: "POST" },
    );
    if (!r.ok) return;
    await refreshSessions();
  }, [taskId, refreshSessions]);

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
    // Poll so the sidebar reflects iter state changes (running → ready →
    // complete) without a manual reload — e.g. an iter flipping to "complete"
    // once its patients are validated, or a fresh re-run superseding a failed
    // one (pickActiveIter then jumps to the latest non-abandoned iter).
    const handle = setInterval(() => void refresh(), 5000);
    // Re-fetch the moment the tab regains focus/visibility. The 5s poll stalls
    // if the connection drops (e.g. the server is restarted mid-session), which
    // would otherwise leave a stale failed run showing until a manual reload.
    const onWake = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      clearInterval(handle);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
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

  // ── Run tabs ──────────────────────────────────────────────────────────────
  // The session's iterations (oldest→newest = Run 1, Run 2, …). Selecting one
  // views BOTH validation (PhaseValidate iterId) and performance (PhaseDecide
  // iter_id) for that run; null follows the active (latest) iter.
  const runIters = useMemo(
    () =>
      (Array.isArray(pilots) ? pilots : [])
        // All of this session's iterations (incl. superseded/"abandoned" ones)
        // so the reviewer can view every run's validation + performance.
        .filter((pp) => !!activeSessionId && pp.session_id === activeSessionId)
        .sort((a, b) => a.iter_num - b.iter_num),
    [pilots, activeSessionId],
  );
  const [selectedIterId, setSelectedIterId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedIterId && !runIters.some((pp) => pp.iter_id === selectedIterId)) {
      setSelectedIterId(null);
    }
  }, [runIters, selectedIterId]);
  const viewIter = useMemo(
    () => runIters.find((pp) => pp.iter_id === selectedIterId) ?? activeIter,
    [runIters, selectedIterId, activeIter],
  );
  // VALIDATE follows the ACTIVE (latest non-abandoned) iter, so a successful
  // re-run clears an earlier run's agent failure. This is safe for the "single
  // ground truth" intent: validation status (oracle_done) is session-scoped —
  // read from var/reviews/<sessionId>/, identical across this session's iters —
  // so it persists unchanged across re-runs regardless of which iter we query.
  // Only the agent draft / errored status is run-scoped, and that should
  // reflect the latest run (see PhaseValidate's own status comment).
  // Run tabs (run 1 / run 2 …) live on DECIDE only.
  const validateIter = activeIter;
  const runTabs =
    runIters.length > 1 ? (
      <div className="flex items-center gap-1 border-b border-border bg-card/40 px-4 py-1.5">
        <span className="mr-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Run</span>
        {runIters.map((it, i) => {
          const on = (viewIter?.iter_id ?? null) === it.iter_id;
          return (
            <button
              key={it.iter_id}
              type="button"
              onClick={() => setSelectedIterId(it.iter_id)}
              className={`rounded px-2 py-0.5 text-[11.5px] ${on ? "bg-[hsl(var(--sage))]/15 text-ink font-medium" : "text-muted-foreground hover:text-ink"}`}
              title={`iteration ${it.iter_id} · ${it.state}`}
            >
              {i + 1}
              {it.state === "running" ? " (running)" : ""}
            </button>
          );
        })}
      </div>
    ) : null;

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

  // Landing phase. An explicit phase in the URL always wins. With no explicit
  // phase, we use the derived phase — EXCEPT we never auto-land on DECIDE
  // (performance) just because the session is complete: entering a task should
  // start on TRY (the run-first entry phase), and the reviewer can click into
  // DECIDE/VALIDATE deliberately. VALIDATE is still auto-resumed mid-review.
  const activePhase: Phase =
    manualPhaseOverride ?? (phaseInfo.phase === "DECIDE" ? "TRY" : phaseInfo.phase);

  // RubricPanel "reveal" nonce, still threaded into PhaseTry's Branch-B
  // RubricPanel as `revealNonce`. The sidebar's "author" jump now targets the
  // dedicated AUTHOR phase (which renders the editor alwaysOpen) instead of
  // bumping this nonce, so it stays 0 — TRY's panel keeps its collapsed
  // default. Mechanism left intact for any future TRY-internal reveal.
  const [revealRubricNonce] = useState(0);

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
          // The rubric this run was frozen against: the friendly version label
          // (s1/v1, snapshotted from the session at run time) for display, plus
          // the content SHA for precise identity. The iter stays pinned to its
          // version even after later rubric edits/switches.
          guideline_sha: (p as { guideline_sha?: string }).guideline_sha,
          rubric: (p as { rubric?: { based_on: string; active_version: string } }).rubric,
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
            onArchive={isMethodologist ? archiveSession : undefined}
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
        {/* No-session gate — every phase EXCEPT author requires an active
            session. AUTHOR is the rubric-editing home; the methodologist can
            edit the rubric before running anything, so it's session-exempt. */}
        {activePhase !== "AUTHOR" && !activeSessionId && (
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

        {/* AUTHOR — the rubric-authoring home. Session-EXEMPT: no
            `activeSessionId` requirement, so the methodologist can edit the
            rubric before starting any session/run. Branch on the raw
            task_type (like PhaseJudge/PhaseDecide) since the shared taskKind
            always resolves to "phenotype" in this fork. */}
        {activePhase === "AUTHOR" && (
          task?.task_type === "adherence" ? (
            <div className="mx-auto max-w-[760px] space-y-5 py-2">
              {/* Editable adherence question rubric — the AUTHOR counterpart to
                  the refinement agent's proposals on PERFORMANCE. */}
              <AdherenceRubricPanel taskId={taskId} />
              <div className="flex justify-end">
                <Button onClick={() => setPhase("TRY")} className="gap-1.5">
                  Try on patients →
                </Button>
              </div>
            </div>
          ) : task?.task_type === "ner" ? (
            <div className="mx-auto max-w-[560px] py-12 space-y-3 text-center">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Author
              </div>
              <h3
                className="font-display text-[20px] tracking-tight"
                style={{ fontVariationSettings: '"opsz" 20, "SOFT" 50' }}
              >
                Author for NER isn't available yet
              </h3>
              <p className="text-[13px] text-muted-foreground">
                Edit entity-type guidance via the Builder for now. A dedicated NER
                authoring pane is a later increment.
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-[760px] space-y-5 py-2">
              {/* AUTHOR is the focused rubric editor. The working-draft diff,
                  version history, and refinement proposals live in the REFINE
                  tab (the git-like workspace) so editing and reviewing each get
                  full room. Edits here flow into the session's working draft. */}
              <RubricPanel taskId={taskId} alwaysOpen activeSessionId={activeSessionId} />
              <div className="flex justify-end gap-2">
                {activeSessionId && (
                  <Button variant="outline" onClick={() => setPhase("REFINE")} className="gap-1.5">
                    Review draft & refine →
                  </Button>
                )}
                <Button onClick={() => setPhase("TRY")} className="gap-1.5">
                  Try on patients →
                </Button>
              </div>
            </div>
          )
        )}

        {/* REFINE — the git-like refinement workspace: draft status + agent
            proposals (left) + the working-draft diff & version history (right).
            Session-gated like the other non-AUTHOR phases. */}
        {activePhase === "REFINE" && activeSessionId && (
          <div className="mx-auto max-w-[1240px] py-2">
            <RefineWorkspace
              taskId={taskId}
              sessionId={activeSessionId}
              left={
                // Phenotype proposal cards only (adherence proposals live in the
                // Performance tab's AdherenceRefinePanel; NER has no proposal UI).
                task?.task_type !== "ner" && task?.task_type !== "adherence" && activeIter ? (
                  <RefineProposalCard
                    taskId={taskId}
                    iterId={activeIter.iter_id}
                    sessionId={activeSessionId}
                  />
                ) : undefined
              }
            />
          </div>
        )}
        {activePhase === "TRY" && activeSessionId && (
          <PhaseTry
            taskId={taskId}
            onAdvanceToValidate={() => setPhase("VALIDATE")}
            activeSessionId={activeSessionId}
            onOpenNewSession={() => setNewSessionOpen(true)}
            taskKind={taskKind}
            revealRubricNonce={revealRubricNonce}
          />
        )}
        {activePhase === "VALIDATE" && activeSessionId && validateIter && (
          <PhaseValidate
            taskId={taskId}
            iterId={validateIter.iter_id}
            onOpenPatient={(pid) => onOpenPatient?.(pid)}
            taskKind={taskKind}
          />
        )}
        {activePhase === "VALIDATE" && activeSessionId && !validateIter && (
          <PilotsEmptyState pilots={pilots} verb="validate" onRetry={refresh} />
        )}
        {activePhase === "JUDGE" && activeSessionId && validateIter && (
          <PhaseJudge
            taskId={taskId}
            iterId={validateIter.iter_id}
            onSkipToValidate={() => setPhase("VALIDATE")}
            // NER tasks render per-span judge cards; phenotype falls back to
            // PatientReview's per-criterion advisory pane. The shared
            // `taskKind` always resolves to "phenotype" (light fork), so
            // branch on the raw task_type here instead.
            taskKind={task?.task_type === "ner" ? "ner" : "phenotype"}
            // Opening a patient renders SpanReview for NER tasks (see App.tsx
            // task_kind dispatch); deep-linking to the exact span is best-effort.
            onOpenSpan={(pid) => onOpenPatient?.(pid)}
          />
        )}
        {activePhase === "JUDGE" && activeSessionId && !validateIter && (
          <PilotsEmptyState pilots={pilots} verb="validate" onRetry={refresh} />
        )}
        {activePhase === "DECIDE" && activeSessionId && (
          <>
            {runTabs}
            <PhaseDecide
              taskId={taskId}
              activeSessionId={activeSessionId}
              iterId={viewIter?.iter_id ?? null}
              // NER scores spans (per-entity-type F1 via /api/calibrate-ner);
              // adherence scores per-agent question/rule agreement vs the
              // reviewer (via /api/pilots/:taskId/:iterId/adherence-iaa, which
              // takes the same viewIter iterId — falls back to the validate
              // iter when no run tab is selected); phenotype scores fields. The
              // shared `taskKind` always resolves to "phenotype" in this fork,
              // so branch on the raw task_type here (same as PhaseJudge above).
              taskKind={
                task?.task_type === "ner"
                  ? "ner"
                  : task?.task_type === "adherence"
                  ? "adherence"
                  : "phenotype"
              }
            />
          </>
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
        onJumpToAuthor={() => setPhase("AUTHOR")}
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
