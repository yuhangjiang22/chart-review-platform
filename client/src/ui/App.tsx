// App — the editorial-scientific shell + Queue view.
//
// Self-contained: handles its own auth, patient list, and active task
// pull. The chat panel + criterion workspace + studio compose inside
// this same shell.
import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch, clearAuth, logout as authLogout, readAuth, whoami, type WhoamiResponse } from "../auth";
import { LoginGate } from "../LoginGate";
import type { CompiledField, NoteFocus, PatientSummary } from "../types";
import { useAgentSocket } from "../useAgentSocket";
import { AppShell } from "./AppShell";
import { QueueView } from "./QueueView";
import { PatientReview } from "./PatientReview";
import { SpanReview } from "./SpanReview";
import { AdherenceReview } from "./AdherenceReview";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { Studio } from "./Studio";
import { Workspace } from "./Workspace";
import { AuditPage } from "./AuditPage";
import { HelpPage } from "./HelpPage";
import { BuilderRoute } from "./builder/BuilderRoute";
import { AuthoringModeDialog } from "./builder/AuthoringModeDialog";
import { AuthoringWizard } from "./builder/AuthoringWizard";
import { TaskKindPickerDialog } from "./builder/TaskKindPickerDialog";
import { TasksIndex } from "./TasksIndex";
import {
  builderHash,
  patientHash,
  queueHash,
  studioHash,
  useHashRoute,
} from "./useHashRoute";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface RuntimeInfo {
  model: string;
  base_url: string;
  default_task_id: string;
  auth_mode: "optional" | "required";
}

interface TaskSummary {
  task_id: string;
  field_count: number;
  task_type?: string;
  manual_version?: string;
  final_output?: string;
}

interface CompiledTaskFull extends TaskSummary {
  fields: CompiledField[];
}

export function App() {
  const [authInfo, setAuthInfo] = useState<WhoamiResponse | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [taskFields, setTaskFields] = useState<CompiledField[]>([]);
  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const { route, navigate } = useHashRoute();
  const [activePatient, setActivePatient] = useState<PatientSummary | null>(null);

  // Track the most recent studio sub-tab the user was on, so the
  // "Patient list" button on a patient page can return there directly
  // (instead of relying on history.back(), which steps through every
  // pushed criterion URL one entry at a time).
  const lastStudioSubTabRef = useRef<string | undefined>(undefined);
  // Tracks (patient:task:latestRun) keys we've already attempted auto-import
  // for, so the import effect can't loop when the latest run has no draft for
  // a patient (errored agent) and the import keeps falling back to an older run.
  const importAttemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (route.page === "studio") lastStudioSubTabRef.current = route.subTab;
  }, [route.page, route.subTab]);
  const [noteFocus, setNoteFocus] = useState<NoteFocus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Two-step new-task flow: kindPicker (step 1) → modePicker (step 2,
  // phenotype only) → AuthoringWizard/Builder. NER + adherence skip
  // step 2 and go straight from the picker through the /api/tasks/scaffold
  // endpoint into the AUTHOR pane.
  const [kindPickerOpen, setKindPickerOpen] = useState(false);
  const [modePickerOpen, setModePickerOpen] = useState(false);
  const [oneShotWizardOpen, setOneShotWizardOpen] = useState(false);

  // Active task is derived from the URL — `route.taskId` is the source of
  // truth; `task` is the matching summary from the loaded list (or null
  // while the list is still loading).
  const task = useMemo<TaskSummary | null>(
    () => (route.taskId ? tasks.find((t) => t.task_id === route.taskId) ?? null : null),
    [tasks, route.taskId],
  );

  // Active session id for the current task — mirrors the same localStorage
  // key that Workspace writes (chart-review:active-session:<taskId>) so that
  // patient-review calls use the session-scoped review root without needing
  // a prop passed through the full Workspace→App→PatientReview chain.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      if (!task?.task_id) { setActiveSessionId(null); return; }
      try {
        setActiveSessionId(localStorage.getItem(`chart-review:active-session:${task.task_id}`));
      } catch {
        setActiveSessionId(null);
      }
    };
    read();
    // Re-read when Workspace switches the active session within the same task —
    // localStorage writes don't fire a 'storage' event in the same tab, so
    // Workspace dispatches a custom 'chart-review:session-changed' event.
    window.addEventListener("chart-review:session-changed", read);
    return () => window.removeEventListener("chart-review:session-changed", read);
  }, [task?.task_id]);

  // Subscribe a single agent socket to whichever patient×task is active.
  // Mirrors how the legacy App lifts useAgentSocket. Until the user picks
  // a patient, patientId is null and the hook stays idle.
  const sock = useAgentSocket(
    authReady && activePatient ? activePatient.patient_id : null,
    task?.task_id ?? null,
    activeSessionId,
  );

  useEffect(() => {
    whoami().then((info) => {
      setAuthInfo(info);
      if (info.authenticated) setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    (async () => {
      const [runtimeBody, taskList, patientList] = await Promise.all([
        authFetch("/api/runtime").then((r) => (r.ok ? r.json() : null)),
        authFetch("/api/tasks").then((r) => (r.ok ? r.json() : [])),
        authFetch("/api/patients").then((r) => (r.ok ? r.json() : [])),
      ]);
      if (cancelled) return;
      const compiledTasks = taskList as TaskSummary[];
      setRuntime(runtimeBody);
      setTasks(compiledTasks);
      setPatients(patientList as PatientSummary[]);
    })();
    return () => { cancelled = true; };
  }, [authReady]);

  // Pull the full compiled task once we know the id, so PatientDetail has
  // the field list to iterate. Resets downstream patient/draft state when
  // the active task changes — same shape as the legacy selectGuideline().
  useEffect(() => {
    if (!authReady) return;
    if (!route.taskId) {
      setTaskFields([]);
      setActivePatient(null);
      setNoteFocus(null);
      return;
    }
    setTaskFields([]);
    setActivePatient(null);
    setNoteFocus(null);
    authFetch(`/api/tasks/${route.taskId}`)
      .then((r) => r.json())
      .then((t: CompiledTaskFull) => setTaskFields(t.fields ?? []));
  }, [authReady, route.taskId]);

  // When a patient is in the URL, hydrate the activePatient state from the
  // loaded patients list. Runs after the task-change reset above so the
  // patient sticks even when arriving directly at `#/patient/<task>/<id>`.
  // When the URL leaves the patient route, clear activePatient — otherwise
  // the AppShell breadcrumb keeps showing "Reviewing / <pid>" on top of a
  // /studio/<task>/<phase> view.
  // If the URL patient_id isn't in the cached corpus list (common for
  // pilot-only patients surfaced by PhaseValidate), fall back to a minimal
  // stub keyed by patient_id alone — without this, clicking such a patient
  // would silently leave activePatient pinned to the previous one.
  useEffect(() => {
    if (!route.patientId) {
      setActivePatient(null);
      return;
    }
    const found = patients.find((p) => p.patient_id === route.patientId);
    if (found) {
      setActivePatient(found);
      return;
    }
    // Stub fallback: enough fields for PatientReview to render and fetch
    // its own state. The full PatientSummary will overwrite this if/when
    // the corpus-wide patients list is refreshed and includes the pid.
    setActivePatient({ patient_id: route.patientId });
  }, [route.patientId, patients]);

  // Reset note focus when patient changes — a stale offset would otherwise
  // try to highlight in the wrong file.
  useEffect(() => {
    setNoteFocus(null);
  }, [activePatient?.patient_id]);

  // Auto-import the agent draft when opening a patient whose review_state
  // is empty OR is stale relative to the latest run.
  //
  // Two trigger paths:
  //   (a) Empty review_state — first patient open after a pilot run.
  //       Without this, PatientDetail shows zero criteria and the
  //       reviewer has nothing to override or accept.
  //   (b) review_state was imported from an older run than the latest one
  //       for this task — DECIDE → TRY "run again" loop. The server-side
  //       merge in /import preserves source=reviewer rows + validated_*
  //       arrays, so the reviewer's prior accept/override answers carry
  //       forward as the gold standard against iter 2+'s new drafts.
  useEffect(() => {
    if (!authReady || !activePatient || !task?.task_id) return;
    const reviewState = sock.reviewState;
    if (!reviewState) return;
    // The socket state lags a patient switch — ignore it until it matches the
    // patient we're actually viewing, so we never act on a stale record.
    if (reviewState.patient_id !== activePatient.patient_id) return;
    // NEVER auto-import over a patient the reviewer has already validated or
    // locked. The human labels are fixed ground truth; re-importing a newer
    // run's drafts would overwrite them (keeping the "validated" flag while
    // wiping the answer → patient silently drops out of the performance count).
    // New runs are scored against this gold from var/runs, not re-seeded here.
    if (
      reviewState.review_status === "reviewer_validated" ||
      reviewState.review_status === "locked"
    ) {
      return;
    }
    const hasWork =
      (reviewState.field_assessments?.length ?? 0) > 0;
    let cancelled = false;
    const patientId = activePatient.patient_id;
    const taskId = task.task_id;
    (async () => {
      // Walk runs newest-first. If review_state already has work, only
      // import when the latest run is newer than imported_from_run —
      // otherwise we'd clobber reviewer work every render.
      // Scope auto-import to THIS session's own runs — never pull drafts from
      // another session's run that happens to cover the same patient.
      const runsQs =
        `?task_id=${encodeURIComponent(taskId)}` +
        (activeSessionId ? `&session_id=${encodeURIComponent(activeSessionId)}` : "");
      const listRes = await authFetch(`/api/runs${runsQs}`);
      if (!listRes.ok || cancelled) return;
      const runs: Array<{ run_id: string }> = await listRes.json();
      if (runs.length === 0) return;
      const latestRunId = runs[0]?.run_id;
      if (hasWork && reviewState.imported_from_run === latestRunId) {
        // already showing the freshest drafts → nothing to do
        return;
      }
      // Attempt auto-import at most ONCE per (patient, latest-run). When the
      // latest run has no draft for this patient (e.g. the agent errored), the
      // import falls back to an older run, so imported_from_run never equals
      // latestRunId and the guard above would re-fire forever — clobbering the
      // reviewer's in-progress answers on every render. This ref breaks that loop.
      const attemptKey = `${patientId}:${taskId}:${latestRunId}`;
      if (importAttemptedRef.current.has(attemptKey)) return;
      importAttemptedRef.current.add(attemptKey);
      for (const run of runs) {
        const importRes = await authFetch(
          `/api/runs/${encodeURIComponent(run.run_id)}/patients/${encodeURIComponent(patientId)}/import`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force: true }),
          },
        );
        if (cancelled) return;
        if (!importRes.ok) continue;
        const sessionQs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";
        const refreshed = await authFetch(
          `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}${sessionQs}`,
        );
        if (refreshed.ok && !cancelled) {
          sock.refreshReviewState(await refreshed.json());
        }
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, activePatient, task?.task_id, sock, activeSessionId]);

  const reviewer = readAuth().reviewer_id ?? (authInfo?.mode === "optional" ? "anonymous" : null);

  function selectGuideline(taskId: string) {
    navigate(studioHash(taskId));
  }

  if (authInfo && !authReady) {
    return (
      <LoginGate
        whoami={authInfo}
        onAuthenticated={async () => {
          setAuthInfo(await whoami());
          setAuthReady(true);
        }}
        onSkip={
          authInfo.mode === "optional"
            ? () => {
                clearAuth();
                setAuthReady(true);
              }
            : undefined
        }
      />
    );
  }

  if (!authReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        <span className="text-sm">Loading…</span>
      </div>
    );
  }

  // Builder accepts a `new` slug for fresh drafts; once the user names the
  // draft, BuilderRoute calls back with the real id and we update the URL.
  const builderTaskIdParam = route.page === "builder" ? (route.taskId ?? "new") : "new";

  const displayedActiveTask = route.page === "builder"
    ? { id: builderTaskIdParam === "new" ? "(new draft)" : builderTaskIdParam, field_count: 0 }
    : task
      ? { id: task.task_id, field_count: task.field_count }
      : { id: "—", field_count: 0 };

  return (
    <AppShell
      fullBleed={route.page === "patient" || route.page === "builder"}
      route={route}
      activePatient={
        activePatient
          ? {
              id: activePatient.patient_id,
              display: activePatient.display_name ?? activePatient.patient_id,
              locked: activePatient.review_status === "locked",
            }
          : null
      }
      activeTask={displayedActiveTask}
      reviewer={reviewer ? { id: reviewer, isMethodologist: authInfo?.is_methodologist } : null}
      onSignOut={
        readAuth().token
          ? async () => {
              await authLogout();
              setAuthInfo(await whoami());
              setAuthReady(false);
            }
          : undefined
      }
      onOpenCommand={() => setPaletteOpen(true)}
      onOpenModePicker={() => setKindPickerOpen(true)}
    >
      {route.page === "tasks" && (
        <TasksIndex
          tasks={tasks.map((t) => ({
            id: t.task_id,
            field_count: t.field_count,
            task_type: t.task_type,
            manual_version: t.manual_version,
          }))}
          onOpen={selectGuideline}
          onCreateTask={() => setKindPickerOpen(true)}
        />
      )}

      {route.page === "queue" && task && (
        <QueueView
          patients={patients}
          status={Object.fromEntries(
            patients.map((p) => [p.patient_id, p.review_status as
              | "agent_proposed"
              | "in_progress"
              | "reviewer_validated"
              | "locked"]),
          )}
          onOpen={(pid) => navigate(patientHash(task.task_id, pid))}
        />
      )}

      {route.page === "patient" && task && route.patientId &&
        // task_kind dispatch — each kind has its own reviewer pane:
        //   ner       → SpanReview (span-validation table, grouped by note)
        //   adherence → AdherenceReview (tier-grouped question framework +
        //               rule verdicts)
        //   phenotype → PatientReview (criterion-row UI)
        // The TaskSummary's task_type is the raw meta.yaml field; the
        // server tags NER tasks with task_type:"ner" and adherence tasks
        // with task_type:"adherence" (mirrors v2).
        (task.task_type === "ner" ? (
          <SpanReview
            patientId={route.patientId}
            patientDisplay={activePatient?.display_name ?? route.patientId}
            taskId={task.task_id}
            activeSessionId={activeSessionId}
            onBack={() =>
              navigate(studioHash(task.task_id, lastStudioSubTabRef.current ?? "validate"))
            }
          />
        ) : task.task_type === "adherence" ? (
          <AdherenceReview
            patientId={route.patientId}
            patientDisplay={activePatient?.display_name ?? route.patientId}
            taskId={task.task_id}
            activeSessionId={activeSessionId}
            onBack={() =>
              navigate(studioHash(task.task_id, lastStudioSubTabRef.current ?? "validate"))
            }
          />
        ) : taskFields.length > 0 ? (
          // Patient pages use PatientReview — the lean ground-truth surface
          // (one card per criterion with inline accept/override). The dual-
          // agent comparison is for adjudication of pilot disagreements and
          // lives in the Pilots → Disagreements tab inside Studio.
          //
          // Routing-critical props (patientId, taskId, onCriterionChange)
          // read from `route` directly, NOT from activePatient. activePatient
          // lags route.patientId by one render (it's hydrated via useEffect),
          // and PatientReview's criterion-defaulter useEffect fires DURING
          // that lag — its onCriterionChange callback used to capture a
          // stale activePatient.patient_id, which would navigate the URL
          // back to the previously-active patient and clobber the click.
          // Using route.patientId here makes the URL the source of truth;
          // activePatient is only consulted for display-only fields.
          <PatientReview
            patientId={route.patientId}
            patientDisplay={activePatient?.display_name ?? route.patientId}
            taskId={task.task_id}
            fields={taskFields}
            reviewState={sock.reviewState}
            onStateChanged={sock.refreshReviewState}
            noteFocus={noteFocus}
            onJumpToSource={setNoteFocus}
            criterionId={route.criterionId ?? null}
            activeSessionId={activeSessionId}
            onCriterionChange={(id, opts) =>
              navigate(
                patientHash(task.task_id, route.patientId!, id ?? undefined),
                opts,
              )
            }
            onOpenPatient={(pid) => navigate(patientHash(task.task_id, pid))}
            onBack={() => {
              // Direct navigation to the studio phase the reviewer came
              // from (or the studio root if we don't know yet). NOT
              // history.back() — when the reviewer has clicked through
              // multiple criteria, each push made history.back() step
              // through them one entry at a time, which is the wrong
              // semantic for a "Patient list" affordance.
              //
              // Fall back to VALIDATE (not an empty subTab) when we don't
              // know where the reviewer came from — e.g. a page refresh reset
              // lastStudioSubTabRef. PatientReview IS the validation surface,
              // so VALIDATE is the correct return target. Without this, an
              // empty subTab falls through to the auto-derived phase, which
              // after the last patient is validated is DECIDE — and the
              // workspace rewrites DECIDE→TRY, dumping the reviewer on TRY.
              navigate(studioHash(task.task_id, lastStudioSubTabRef.current ?? "validate"));
            }}
          />
        ) : (
          <PatientStub
            patient={activePatient}
            onBack={() => navigate(queueHash(task.task_id))}
          />
        ))}

      {route.page === "studio" && task && (
        <Workspace
          key={task.task_id}
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
            // Always navigate to the Builder against the same task id. The
            // server seeds the draft directory from the locked guideline on
            // first open if it doesn't already exist (see
            // autoForkFromLockedIfMissing in builder-session.ts), so a
            // single URL handles both the draft-in-progress and edit-the-
            // locked-guideline cases.
            navigate(builderHash(task.task_id));
          }}
          onOpenPatient={(pid) => navigate(patientHash(task.task_id, pid))}
        />
      )}
      {route.page === "audit" && task && (
        <AuditPage
          taskId={task.task_id}
          onOpenPatient={(pid) => navigate(patientHash(task.task_id, pid))}
          sessionId={activeSessionId}
        />
      )}
      {route.page === "help" && <HelpPage />}

      {route.page === "builder" && (
        <BuilderRoute
          taskId={builderTaskIdParam}
          token={readAuth().token ?? ""}
          onTaskIdConfirmed={(id) => {
            if (id && id !== builderTaskIdParam) navigate(builderHash(id));
          }}
          onDraftComplete={() => {
            // B3: Builder agent finished a turn — re-fetch the task list so
            // the Library shows the new draft without a hard reload.
            authFetch("/api/tasks")
              .then((r) => (r.ok ? r.json() : []))
              .then((list: TaskSummary[]) => setTasks(list))
              .catch(() => {});
          }}
        />
      )}

      {/* ⌘K command palette — global. Mounts at the root so the keydown
       *  listener works from every route. */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        tasks={tasks.map((t) => ({ id: t.task_id, field_count: t.field_count }))}
        criteria={taskFields}
        activePatientId={activePatient?.patient_id ?? null}
        onJumpTask={selectGuideline}
        onJumpCriterion={(fieldId) => {
          if (task) navigate(studioHash(task.task_id));
          window.dispatchEvent(
            new CustomEvent("ui:select-guideline-criterion", { detail: { fieldId } }),
          );
        }}
        onAction={(a: PaletteAction) => {
          if (!task) return;
          if (a === "start-pilot") {
            navigate(studioHash(task.task_id, "pilots"));
          } else if (a === "run-calibration") {
            navigate(studioHash(task.task_id, "calibration"));
          } else if (a === "draft-methods") {
            navigate(studioHash(task.task_id, "methods"));
          } else if (a === "export-bundle") {
            navigate(studioHash(task.task_id, "bundles"));
          }
        }}
      />

      {void runtime}

      {/* Step 1 — task-kind picker. Phenotype falls through to the
       *  existing AuthoringModeDialog; NER + adherence call the scaffold
       *  endpoint and jump straight into the AUTHOR pane of the new task. */}
      <TaskKindPickerDialog
        open={kindPickerOpen}
        onClose={() => setKindPickerOpen(false)}
        onPickPhenotype={() => {
          setKindPickerOpen(false);
          setModePickerOpen(true);
        }}
        onScaffolded={(newTaskId) => {
          setKindPickerOpen(false);
          // Refresh the task list so the new skeleton shows up, then
          // jump into its AUTHOR pane.
          authFetch("/api/tasks")
            .then((r) => (r.ok ? r.json() : []))
            .then((list: TaskSummary[]) => setTasks(list))
            .catch(() => {});
          navigate(studioHash(newTaskId, "author"));
        }}
      />

      {/* Step 2 — phenotype-only mode picker (Builder vs One-shot). */}
      <AuthoringModeDialog
        open={modePickerOpen}
        onClose={() => setModePickerOpen(false)}
        onPickBuilder={() => {
          setModePickerOpen(false);
          navigate(builderHash("new"));
        }}
        onPickOneShot={() => {
          setModePickerOpen(false);
          setOneShotWizardOpen(true);
        }}
      />

      {oneShotWizardOpen && (
        <AuthoringWizard
          onClose={() => setOneShotWizardOpen(false)}
          onCompleted={(newTaskId) => {
            // Refresh the task list so the new draft appears, then jump
            // straight into the Builder against it.
            authFetch("/api/tasks")
              .then((r) => (r.ok ? r.json() : []))
              .then((list: TaskSummary[]) => setTasks(list))
              .catch(() => {});
            setOneShotWizardOpen(false);
            navigate(builderHash(newTaskId));
          }}
        />
      )}

    </AppShell>
  );
}

function PatientStub({ patient, onBack }: { patient: PatientSummary | null; onBack: () => void }) {
  if (!patient) {
    return (
      <Card className="animate-rise-in">
        <CardContent className="py-10 text-center text-muted-foreground">
          <div className="text-[15px] text-foreground">No patient selected</div>
          <div className="mt-1 text-[13px]">Pick one from the queue to begin.</div>
          <Button className="mt-4" variant="outline" onClick={onBack}>
            <ArrowLeft size={14} /> Back to Queue
          </Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="animate-rise-in">
      <Button variant="ghost" size="sm" className="mb-4" onClick={onBack}>
        <ArrowLeft size={14} /> Queue
      </Button>
      <h1
        className="text-[32px] tracking-tight"
        style={{ fontVariationSettings: '"opsz" 50, "SOFT" 50' }}
      >
        {patient.display_name ?? patient.patient_id}
      </h1>
      <p className="mt-2 text-[14px] text-muted-foreground">
        Patient detail (criteria · evidence · chat copilot) lands in the next phase.
      </p>
      <Card className="mt-6">
        <CardContent className="py-8 text-center text-muted-foreground">
          <div className="text-[15px] text-foreground">Patient detail — Phase 3</div>
          <div className="mt-1 text-[13px] max-w-[52ch] mx-auto">
            This is where the new fixed chat-copilot rail + criterion workspace +
            evidence pane will live, replacing the three-mode layout cycle.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
