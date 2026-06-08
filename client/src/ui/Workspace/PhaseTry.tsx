import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Play, Square, RotateCcw, Shuffle } from "lucide-react";
import { authFetch } from "../../auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { AgentConfigPanel, type AgentSpecForm } from "../PilotsTab/AgentConfigPanel";
import { AgentLogPanel } from "./AgentLogPanel";

interface Patient {
  patient_id: string;
  display_name?: string;
  category?: string;
  difficulty?: string;
  headline?: string;
}

interface IterListing {
  iter_id: string;
  iter_num: number;
  /** Session this iter belongs to. Absent on legacy/pre-session iters. */
  session_id?: string;
  state: "running" | "ready_to_validate" | "complete" | "abandoned" | string;
  run_status: "running" | "complete" | "complete_with_errors" | "failed" | string | null;
  n_complete?: number;
  n_patients?: number;
  started_at: string;
  started_by: string;
  provider?: "claude" | "codex";
  run_id?: string;
}

interface IterDetailResponse {
  patient_status: Array<{ patient_id: string; oracle_done: boolean; agent_done: boolean }>;
}

interface PhaseTryProps {
  taskId: string;
  /** Called when the user clicks "Validate run" on the in-flight/completed
   *  run card. Parent moves the workspace into the VALIDATE phase. */
  onAdvanceToValidate?: () => void;
  /** Active session id (null when no session is selected). Every iter
   *  started from this pane is bound to the active session; without one,
   *  the start UI shows a "Start new session first" gate. */
  activeSessionId?: string | null;
  /** Open the new-session dialog (parent owns dialog state). Used by the
   *  no-session gate to give the user a one-click path to fix the issue. */
  onOpenNewSession?: () => void;
  /** Task kind — drives the runtime indicator in the agent readout.
   *  ner = direct LLM call (no agent runtime); phenotype/adherence
   *  use Claude SDK or Codex CLI based on AGENT_PROVIDER. */
  taskKind?: "phenotype" | "ner" | "adherence";
}

/**
 * TRY phase — one cycle = one run. Shows the current run's status (or a
 * patient picker + agent config when no run is in flight). Historical iters
 * are bookkeeping; the user only sees the active one. To override an active
 * run, the user abandons it and starts a fresh one with new selections.
 */
export function PhaseTry({
  taskId, onAdvanceToValidate, activeSessionId, onOpenNewSession, taskKind,
}: PhaseTryProps) {
  // Session manifest — source of truth for cohort + agent_specs.
  // Loaded fresh whenever activeSessionId changes.
  const [sessionCohort, setSessionCohort] = useState<string[]>([]);
  const [sessionAgentSpecs, setSessionAgentSpecs] = useState<AgentSpecForm[]>([]);
  const [sessionName, setSessionName] = useState<string>("");
  // Agent runtime — derived from /api/runtime when task_kind needs an
  // agent loop (phenotype/adherence). NER skips this — direct LLM.
  const [agentProvider, setAgentProvider] = useState<string | null>(null);
  useEffect(() => {
    if (taskKind === "ner") { setAgentProvider(null); return; }
    let cancelled = false;
    authFetch("/api/runtime")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { agent_provider?: string } | null) => {
        if (cancelled || !d) return;
        setAgentProvider(d.agent_provider ?? null);
      })
      .catch(() => { /* swallow */ });
    return () => { cancelled = true; };
  }, [taskKind]);

  const runtimeLabel = taskKind === "ner"
    ? "direct LLM call to Azure /responses (no agent runtime)"
    : agentProvider === "claude"
      ? "Claude Agent SDK (tool-using agent loop)"
      : agentProvider === "codex"
        ? "Codex CLI (tool-using agent loop)"
        : "agent runtime: (loading…)";
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [agentSpecs, setAgentSpecs] = useState<AgentSpecForm[]>([
    { id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default" },
    { id: "agent_2", search_mode_preset: "smart-search", interpretation_preset: "skeptical" },
  ]);

  // Load session manifest when activeSessionId changes.
  useEffect(() => {
    if (!activeSessionId) {
      setSessionCohort([]); setSessionAgentSpecs([]); setSessionName("");
      return;
    }
    let cancelled = false;
    authFetch(`/api/sessions/${encodeURIComponent(taskId)}/${encodeURIComponent(activeSessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.session) return;
        setSessionCohort(d.session.cohort?.patient_ids ?? []);
        // Accept either field name — old manifests on disk still have
        // `default_agent_specs`; new ones use `agent_specs`.
        setSessionAgentSpecs(d.session.agent_specs ?? d.session.default_agent_specs ?? []);
        setSessionName(d.session.name ?? "");
      })
      .catch(() => { /* swallow; UI shows empty boxes */ });
    return () => { cancelled = true; };
  }, [taskId, activeSessionId]);
  const [activeIter, setActiveIter] = useState<IterListing | null>(null);
  const [activeIterPatients, setActiveIterPatients] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Loaders ───────────────────────────────────────────────────────────────

  const loadActiveIter = useCallback(async () => {
    // No active session → no run is "current" for this view. The gate
    // below renders instead of any iter status.
    if (!activeSessionId) {
      setActiveIter(null);
      setActiveIterPatients([]);
      return;
    }
    const r = await authFetch(`/api/pilots/${encodeURIComponent(taskId)}`);
    if (!r.ok) {
      setActiveIter(null);
      return;
    }
    const iters: IterListing[] = await r.json();
    // Only iters that belong to the active session count. Legacy iters
    // (no session_id) and iters from other sessions are filtered out so
    // they don't bleed into the current view.
    const sessionIters = iters.filter((i) => i.session_id === activeSessionId);
    const live = sessionIters.find((i) => i.state !== "abandoned") ?? null;
    setActiveIter(live);
    if (live) {
      const d = await authFetch(
        `/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(live.iter_id)}`,
      );
      if (d.ok) {
        const detail: IterDetailResponse = await d.json();
        setActiveIterPatients(detail.patient_status.map((p) => p.patient_id));
      }
    } else {
      setActiveIterPatients([]);
    }
  }, [taskId, activeSessionId]);

  // Load corpus + initial selection. Default chain (first hit wins):
  //   1. live iter's patients (handled by the activeIter sync effect below)
  //   2. most-recent abandoned iter's patients (preserve last selection
  //      across stop/override)
  //   3. sampling.json dev_patient_ids if a cohort was curated
  //   4. empty (user picks)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [pr, iters, sr] = await Promise.all([
        authFetch("/api/patients").then((r) => (r.ok ? r.json() : [])),
        authFetch(`/api/pilots/${encodeURIComponent(taskId)}`)
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => [] as IterListing[]),
        authFetch(`/api/cohort-sampling/${encodeURIComponent(taskId)}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (cancelled) return;
      const list: Patient[] = Array.isArray(pr) ? pr : [];
      setPatients(list);
      const valid = new Set(list.map((p) => p.patient_id));

      // Live iter case — let the activeIter sync effect populate selection.
      const live = (iters as IterListing[]).find((i) => i.state !== "abandoned");
      if (live) return;

      // Fallback: most recent abandoned iter's patients
      const abandoned = (iters as IterListing[]).find((i) => i.state === "abandoned");
      if (abandoned) {
        const d = await authFetch(
          `/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(abandoned.iter_id)}`,
        );
        if (!cancelled && d.ok) {
          const detail: IterDetailResponse = await d.json();
          const seed = detail.patient_status.map((p) => p.patient_id).filter((id) => valid.has(id));
          if (seed.length > 0) {
            setSelected(seed);
            return;
          }
        }
      }

      // Fallback: curated dev cohort
      const dev: string[] = sr?.dev_patient_ids ?? [];
      const seed = dev.filter((id) => valid.has(id));
      setSelected(seed);
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  useEffect(() => {
    loadActiveIter();
  }, [loadActiveIter]);

  // Poll while the run is in flight.
  useEffect(() => {
    const inFlight = activeIter?.state === "running";
    if (!inFlight) return;
    const handle = setInterval(loadActiveIter, 4000);
    return () => clearInterval(handle);
  }, [activeIter, loadActiveIter]);

  // When an active iter finishes, snap the form's selection to that iter's
  // patients so a "Run again" inherits the same set.
  useEffect(() => {
    if (activeIter && activeIterPatients.length > 0) {
      setSelected(activeIterPatients);
    }
  }, [activeIter?.iter_id, activeIterPatients.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ───────────────────────────────────────────────────────────────

  async function startRun() {
    if (!activeSessionId) {
      setError("No active session. Start a session first (top bar → Start new session).");
      return;
    }
    setBusy(true);
    setError(null);
    // Cohort + agents come from the session (strict lock); we only pass session_id.
    const r = await authFetch(`/api/pilots/${encodeURIComponent(taskId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: activeSessionId,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(`Start failed: ${(await r.json().catch(() => ({}))).error ?? r.status}`);
      return;
    }
    loadActiveIter();
  }

  async function abandonActive(): Promise<boolean> {
    if (!activeIter) return true;
    const r = await authFetch(
      `/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(activeIter.iter_id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "abandoned" }),
      },
    );
    if (!r.ok) {
      setError(`Stop failed: ${r.status}`);
      return false;
    }
    return true;
  }

  async function stopRun() {
    setBusy(true);
    const ok = await abandonActive();
    setBusy(false);
    if (ok) loadActiveIter();
  }

  async function overrideRun() {
    setBusy(true);
    const ok = await abandonActive();
    setBusy(false);
    if (!ok) return;
    // Reset activeIter so the form re-renders. Do NOT auto-start — the user
    // clicked "Override with new config" specifically to adjust the patient
    // selection and/or agent specs before re-running. The form preserves the
    // previous selection so a same-config re-run is one click away.
    setActiveIter(null);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Gate first: no active session → no run visible, no form. The user
  // must start a session before anything in TRY renders. This is the
  // "no session, no run" invariant the methodologist asked for —
  // including hiding any legacy in-flight runs from other sessions.
  if (!activeSessionId) {
    return (
      <div className="mx-auto max-w-[520px] py-12 space-y-4 text-center">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          No active session
        </div>
        <h3 className="font-display text-[22px] tracking-tight" style={{ fontVariationSettings: '"opsz" 22, "SOFT" 50' }}>
          Sessions are required to run agents on patients
        </h3>
        <p className="text-[13px] text-muted-foreground">
          A session locks the cohort + agent config so every iter inside it stays
          comparable. Start a session to pick patients, configure agents, and kick
          off the first iter — all in one place.
        </p>
        {onOpenNewSession && (
          <Button onClick={onOpenNewSession} className="gap-1.5">
            <Play size={12} strokeWidth={1.75} />
            Start new session
          </Button>
        )}
      </div>
    );
  }

  // Branch A: a run is in flight or just completed (within this session).
  if (activeIter && activeIter.state !== "abandoned") {
    return (
      <RunStatusCard
        iter={activeIter}
        patientIds={activeIterPatients}
        agentSpecs={agentSpecs}
        onStop={stopRun}
        onOverride={overrideRun}
        onValidate={onAdvanceToValidate}
        busy={busy}
        error={error}
      />
    );
  }

  // Branch B: no live run inside this session — render the session's
  // LOCKED cohort + agents (read from the session manifest, NOT from
  // workspace state) and a "Start iter" CTA.
  return (
    <div className="mx-auto max-w-[640px] space-y-6 py-6">
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Session-locked configuration {sessionName && `· ${sessionName}`}
        </div>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Cohort and agents are fixed for this session. To change them,
          start a new session.
        </p>
      </div>

      <div className="rounded-md border border-border bg-paper/40 px-4 py-3">
        <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground mb-1">
          Cohort ({sessionCohort.length} patient{sessionCohort.length === 1 ? "" : "s"})
        </div>
        {sessionCohort.length === 0 ? (
          <div className="text-[12px] text-muted-foreground italic">
            (loading session…)
          </div>
        ) : (
          <div className="max-h-[140px] overflow-y-auto font-mono text-[11.5px] text-ink space-y-0.5">
            {sessionCohort.map((pid) => (
              <div key={pid} className="truncate">{pid}</div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-md border border-border bg-paper/40 px-4 py-3">
        <div className="flex items-baseline justify-between mb-1">
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {taskKind === "ner" ? "Reviewers" : "Agents"} ({sessionAgentSpecs.length})
          </div>
          <div className="text-[10px] text-muted-foreground/80 italic">
            {runtimeLabel}
          </div>
        </div>
        {sessionAgentSpecs.length === 0 ? (
          <div className="text-[12px] text-muted-foreground italic">
            (loading session…)
          </div>
        ) : (
          <div className="text-[12px] font-mono text-ink space-y-1">
            {sessionAgentSpecs.map((s) => {
              const parts = [
                s.search_mode_preset,
                s.interpretation_preset,
                s.model || "(server default model)",
              ].filter(Boolean);
              return (
                <div key={s.id} className="truncate">
                  <span className="text-muted-foreground">{s.id}:</span>{" "}
                  {parts.join(" · ")}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && <div className="text-[12px] text-[hsl(var(--oxblood))]">{error}</div>}

      <div className="flex justify-end">
        <Button
          size="sm"
          className="gap-1.5"
          disabled={busy || sessionCohort.length === 0}
          onClick={() => startRun()}
        >
          <Play size={12} strokeWidth={1.75} />
          {busy ? "Starting…" : "Start iter"}
        </Button>
      </div>
    </div>
  );
}

// ── Run status (active or completed) ─────────────────────────────────────────

function RunStatusCard({
  iter,
  patientIds,
  onStop,
  onOverride,
  onValidate,
  busy,
  error,
}: {
  iter: IterListing;
  patientIds: string[];
  agentSpecs: AgentSpecForm[];
  onStop: () => void;
  onOverride: () => void;
  onValidate?: () => void;
  busy: boolean;
  error: string | null;
}) {
  // Derive readiness/running from the LIVE run status (status.json), not the
  // persisted iter.state. The manifest state stays "running" after the run
  // finishes (it only flips on an explicit transition), so keying off it leaves
  // the card stuck on "running" with no validate affordance even at 100%.
  const isFailed = iter.run_status === "failed";
  const isPartial = iter.run_status === "complete_with_errors";
  const runDone = iter.run_status === "complete" || iter.run_status === "complete_with_errors";
  const isReady = !isFailed && (runDone || iter.state === "ready_to_validate" || iter.state === "complete");
  const isRunning = !isReady && !isFailed;
  const total = iter.n_patients ?? patientIds.length;
  const done = iter.n_complete ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Current run
          </span>
          <Badge
            variant={isFailed ? "locked" : isReady ? "validated" : "primary"}
            className="!text-[10px]"
          >
            {isFailed
              ? "failed"
              : isReady
                ? `ready · validate${isPartial ? " · partial" : ""}`
                : "running"}
          </Badge>
          {iter.provider && (
            <span
              className={
                "inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono " +
                (iter.provider === "codex"
                  ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                  : "bg-violet-100 text-violet-800 border-violet-300")
              }
            >
              {iter.provider === "codex" ? "Codex" : "Claude"}
            </span>
          )}
        </div>
        <div className="text-[12px] text-muted-foreground">
          started {iter.started_at.slice(0, 16)} · {iter.started_by}
        </div>
      </header>

      <div className="rounded-md border border-border bg-card p-5 space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="font-display text-[15.5px]">
            {done} / {total} patients drafted
          </span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {pct}%
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full transition-all",
              isFailed
                ? "bg-[hsl(var(--oxblood))]"
                : isReady
                  ? "bg-[hsl(var(--sage))]"
                  : "bg-[hsl(var(--oxblood))]",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        {patientIds.length > 0 && (
          <details className="text-[11.5px]">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Patient ids ({patientIds.length})
            </summary>
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-foreground">
              {patientIds.map((pid) => (
                <li key={pid}>{pid}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {iter.run_id && patientIds.length > 0 && (
        <AgentLogPanel
          runId={iter.run_id}
          patientIds={patientIds}
          live={isRunning}
        />
      )}

      {error && <div className="text-[12px] text-[hsl(var(--oxblood))]">{error}</div>}

      <div className="flex justify-end gap-2">
        {isRunning && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={busy}
            onClick={onStop}
          >
            <Square size={12} strokeWidth={1.75} />
            Stop run
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={busy}
          onClick={onOverride}
        >
          <RotateCcw size={12} strokeWidth={1.75} />
          {isRunning ? "Override with new config" : "Re-run with new config"}
        </Button>
        {isReady && onValidate && (
          <Button size="sm" className="gap-1.5" onClick={onValidate}>
            Validate run
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Patient picker ──────────────────────────────────────────────────────────

function PatientPicker({
  patients,
  selected,
  onChange,
}: {
  patients: Patient[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  function toggle(id: string) {
    if (selectedSet.has(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  }

  function selectAll() {
    onChange(patients.map((p) => p.patient_id));
  }

  function clearAll() {
    onChange([]);
  }

  function pickRandom(n: number) {
    const ids = [...patients.map((p) => p.patient_id)];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    onChange(ids.slice(0, Math.min(n, ids.length)));
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Patients for this run
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Pick from the corpus. The agent will draft answers for every selected patient.
          </p>
        </div>
        <div className="flex gap-2 text-[11px]">
          <button
            type="button"
            onClick={selectAll}
            className="text-muted-foreground hover:text-foreground"
          >
            Select all
          </button>
          <span className="text-muted-foreground/40">·</span>
          <button
            type="button"
            onClick={() => pickRandom(5)}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <Shuffle size={10} strokeWidth={1.75} />
            Random 5
          </button>
          <span className="text-muted-foreground/40">·</span>
          <button
            type="button"
            onClick={clearAll}
            className="text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        </div>
      </div>
      <ul className="rounded-md border border-border bg-card divide-y divide-border max-h-[420px] overflow-auto">
        {patients.map((p) => {
          const checked = selectedSet.has(p.patient_id);
          return (
            <li key={p.patient_id}>
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-3 px-4 py-2.5 transition-colors",
                  checked ? "bg-[hsl(var(--oxblood))]/5" : "hover:bg-muted/30",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(p.patient_id)}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <code className="font-mono text-[12px] text-foreground">
                      {p.patient_id}
                    </code>
                    {p.category && (
                      <Badge variant="outline" className="!text-[10px]">
                        {p.category}
                      </Badge>
                    )}
                    {p.difficulty && (
                      <Badge variant="outline" className="!text-[10px]">
                        {p.difficulty}
                      </Badge>
                    )}
                  </div>
                  {p.headline && (
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                      {p.headline}
                    </p>
                  )}
                </div>
              </label>
            </li>
          );
        })}
        {patients.length === 0 && (
          <li className="px-4 py-3 text-[12px] italic text-muted-foreground">
            No patients in corpus.
          </li>
        )}
      </ul>
    </section>
  );
}

