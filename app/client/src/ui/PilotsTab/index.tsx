// PilotsTab — Figure 1 · Pilots, extracted from Studio.tsx.
// Mechanical move: PilotsFigure, PilotRow, StateBadge live here so T13-T19
// can add features without growing Studio.tsx further.
import { useEffect, useState, useCallback } from "react";
import { ChevronRight, Play } from "lucide-react";
import { authFetch } from "../../auth";
import type { PilotListing } from "./types";
import type { EligibilityResult } from "./types";
import { EligibilityPip } from "./EligibilityPip";
import { TrajectoryChart } from "./TrajectoryChart";
import { FigurePage, FigureStats, Stat, EmptyHint } from "../figure-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { IterDetail } from "./IterDetail";
import { LockTestRow, type LockTestManifest } from "./LockTestRow";
import { CohortCurationModal } from "./CohortCurationModal";
import { AuthoringHandoffCard } from "./AuthoringHandoffCard";
import { AgentConfigPanel, type AgentSpecForm } from "./AgentConfigPanel";
import { RerunPreviewBanner } from "./RerunPreviewBanner";

export function PilotsFigure({
  taskId,
  onOpenPatient,
}: {
  taskId: string;
  /** Open a patient chart from any pilot context — patient chip in the
   *  iteration detail, or "Open" on a disagreement row. */
  onOpenPatient?: (patientId: string, fieldId?: string) => void;
}) {
  const [pilots, setPilots] = useState<PilotListing[]>([]);
  const [eligibility, setEligibility] = useState<EligibilityResult | null>(null);
  const [expandedIterId, setExpandedIterId] = useState<string | null>(null);
  const [lockTests, setLockTests] = useState<LockTestManifest[]>([]);
  const [cohortModalOpen, setCohortModalOpen] = useState(false);
  const [cohortExists, setCohortExists] = useState<boolean | null>(null);
  const [criterionCount, setCriterionCount] = useState<number>(0);
  const [guidelineSha, setGuidelineSha] = useState<string>("");
  const [agentSpecs, setAgentSpecs] = useState<AgentSpecForm[]>([
    { id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default" },
    { id: "agent_2", search_mode_preset: "smart-search", interpretation_preset: "skeptical" },
  ]);
  useEffect(() => {
    authFetch(`/api/guidelines/${taskId}/sha`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.sha && setGuidelineSha(d.sha))
      .catch(() => {});
    authFetch(`/api/tasks/${taskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.fields != null && setCriterionCount(d.fields.length))
      .catch(() => {});
  }, [taskId]);
  const refreshPilots = useCallback(() => {
    authFetch(`/api/pilots/${taskId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setPilots)
      .catch(() => setPilots([]));
  }, [taskId]);
  useEffect(() => { refreshPilots(); }, [refreshPilots]);

  // Poll while any iter is running so the n_complete/n_patients counter
  // and state badges advance live without a manual refresh.
  useEffect(() => {
    const anyRunning = pilots.some(
      (p) => p.state === "running" || p.run_status === "running" || p.run_status === "queued",
    );
    if (!anyRunning) return;
    const handle = setInterval(refreshPilots, 5000);
    return () => clearInterval(handle);
  }, [pilots, refreshPilots]);
  useEffect(() => {
    authFetch(`/api/pilots/${taskId}/eligibility`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setEligibility)
      .catch(() => setEligibility(null));
  }, [taskId]);
  const refreshLockTests = useCallback(() => {
    authFetch(`/api/lock-test/${taskId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setLockTests)
      .catch(() => setLockTests([]));
  }, [taskId]);
  useEffect(() => { refreshLockTests(); }, [refreshLockTests]);
  useEffect(() => {
    authFetch(`/api/cohort-sampling/${taskId}`)
      .then((r) => setCohortExists(r.ok))
      .catch(() => setCohortExists(false));
  }, [taskId]);

  const totalProposals = pilots.reduce((acc, p) => acc + (p.critique?.proposal_count ?? 0), 0);
  const auto = pilots.some((p) => p.auto_critique_state === "running");

  const trajectoryIters = pilots
    .filter((p) => p.state === "complete" && p.critique?.accuracy)
    .sort((a, b) => a.iter_num - b.iter_num)
    .map((p) => ({
      iter_id: p.iter_id,
      per_criterion: p.critique!.accuracy!.per_criterion,
      worst_accuracy: p.critique!.accuracy!.worst_accuracy,
    }));

  return (
    <FigurePage
      caption="Figure 1"
      title="Iteration timeline"
      lede="Each iteration: the agent runs on the dev cohort, reviewers validate, you mark complete, and auto-critique clusters reviewer overrides into rule proposals (drain those in the Rules tab). Loop until two consecutive iterations meet eligibility, then transition maturity to piloted. Newest first."
    >
      {trajectoryIters.length >= 2 && (
        <figure className="mt-12 mb-10">
          <TrajectoryChart iters={trajectoryIters} />
        </figure>
      )}

      <FigureStats>
        <Stat label="Iterations" value={String(pilots.length)} />
        <Stat label="Proposals (total)" value={String(totalProposals)} accent={totalProposals > 0} />
        <Stat label="Auto-critique" value={auto ? "running" : "idle"} mute />
      </FigureStats>

      {pilots.length === 0 && cohortExists === false ? (
        <AuthoringHandoffCard
          taskId={taskId}
          criterionCount={criterionCount}
          guidelineSha={guidelineSha}
          onCurate={() => setCohortModalOpen(true)}
        />
      ) : (
        <>
          {cohortExists === false && (
            <div className="mb-6 flex justify-center">
              <Button variant="default" size="sm" onClick={() => setCohortModalOpen(true)}>
                Curate cohorts →
              </Button>
            </div>
          )}

          <Separator className="my-8" />

          {eligibility && (
            <>
              <div className="mb-4">
                <EligibilityPip eligibility={eligibility} />
              </div>
              {eligibility.eligible && (
                <div className="mb-6 flex justify-center">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={async () => {
                      await authFetch(`/api/lock-test/${taskId}/start`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ started_by: "test_pi" }),
                      });
                      refreshLockTests();
                    }}
                  >
                    Run lock test
                  </Button>
                </div>
              )}
            </>
          )}

          <div className="mb-6 space-y-4">
            <AgentConfigPanel value={agentSpecs} onChange={setAgentSpecs} />
            <RerunPreviewBanner taskId={taskId} agentCount={agentSpecs.length} />
            <div className="flex justify-center">
              <Button
                variant="default"
                size="sm"
                onClick={async () => {
                  // Read dev_patient_ids out of sampling.json on the server, then
                  // pass them as the patient_ids the pilot iterates against.
                  const samp = await authFetch(`/api/cohort-sampling/${taskId}`);
                  if (!samp.ok) {
                    alert(
                      `Cannot start: cohort sampling not configured. Open "Curate cohorts" first.`,
                    );
                    return;
                  }
                  const sampling = await samp.json();
                  const patientIds: string[] = sampling?.dev_patient_ids ?? [];
                  if (patientIds.length === 0) {
                    alert(
                      `Cannot start: dev_patient_ids is empty in sampling.json.`,
                    );
                    return;
                  }
                  const r = await authFetch(`/api/pilots/${taskId}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ patient_ids: patientIds, agent_specs: agentSpecs }),
                  });
                  if (!r.ok) {
                    const body = await r.json().catch(() => ({}));
                    alert(`Start iteration failed: ${body.error ?? r.status}`);
                    return;
                  }
                  // Refresh pilots list so the new iter appears immediately;
                  // polling will then keep n_complete advancing.
                  refreshPilots();
                }}
              >
                <Play className="h-3.5 w-3.5 mr-1" />
                {pilots.length === 0 ? "Start first iteration" : "Start new iteration"}
              </Button>
            </div>
          </div>

          {pilots.length === 0 && lockTests.length === 0 ? (
            <EmptyHint
              icon={Play}
              title="No iterations yet"
              body={
                <>Click <em>Start first iteration</em> above. The agent reads each <code className="font-mono">dev_patient_ids</code> patient's notes and answers your criteria; each patient takes ~30s–2min. Once it's done, validate the drafts and click <em>Mark complete</em> — auto-critique fires and surfaces rule proposals in the Rules tab.</>
              }
            />
          ) : (
            <ol className="space-y-3">
              {lockTests.length > 0 && (
                <LockTestRow
                  key={lockTests[0].run_id}
                  taskId={taskId}
                  m={lockTests[0]}
                  onChange={refreshLockTests}
                />
              )}
              {pilots.map((p, idx) => (
                <li key={p.iter_id} className="border-b border-border/60 last:border-b-0">
                  <PilotRow
                    p={p}
                    index={pilots.length - idx}
                    expanded={expandedIterId === p.iter_id}
                    onClick={() =>
                      setExpandedIterId((c) => (c === p.iter_id ? null : p.iter_id))
                    }
                  />
                  {expandedIterId === p.iter_id && (
                    <IterDetail taskId={taskId} p={p} onOpenPatient={onOpenPatient} />
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {cohortModalOpen && (
        <CohortCurationModal
          taskId={taskId}
          onClose={() => setCohortModalOpen(false)}
          onSaved={() => setCohortExists(true)}
        />
      )}
    </FigurePage>
  );
}

function PilotRow({
  p,
  index,
  expanded,
  onClick,
}: {
  p: PilotListing;
  index: number;
  expanded?: boolean;
  onClick?: () => void;
}) {
  const proposals = p.critique?.proposal_count ?? 0;
  const auto = p.auto_critique_state === "running";
  return (
    <div
      className="grid grid-cols-[60px_1fr_auto] items-baseline gap-6 pb-3 cursor-pointer select-none"
      onClick={onClick}
    >
      <div className="font-display text-[26px] tabular-nums text-ink/40">{String(index).padStart(2, "0")}</div>
      <div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12.5px] text-ink">{p.iter_id}</span>
          <PhaseBadge phase={p.phase} fallback={{ state: p.state, runStatus: p.run_status }} />
          {auto && <Badge variant="warning" className="!text-[10px]">auto-critiquing…</Badge>}
        </div>
        <div className="mt-1 text-[12.5px] text-muted-foreground">
          {p.n_complete}/{p.n_patients} complete · started {p.started_at.slice(0, 16)} · {p.started_by}
        </div>
        {p.accuracy_summary && (
          <div className="mt-1 flex items-center gap-2 text-[11.5px] tabular-nums">
            <span
              className={cn(
                "font-mono",
                p.accuracy_summary.worst && p.accuracy_summary.worst.accuracy < 0.9
                  ? "text-[hsl(var(--oxblood))]"
                  : "text-foreground",
              )}
            >
              {p.accuracy_summary.worst ? p.accuracy_summary.worst.accuracy.toFixed(2) : "—"}
            </span>
            <span className="text-muted-foreground/50">/</span>
            <span className="font-mono text-muted-foreground">
              {p.accuracy_summary.avg != null ? p.accuracy_summary.avg.toFixed(2) : "—"}
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
              worst · avg
            </span>
          </div>
        )}
        {p.notes && <div className="mt-1 text-[12px] italic text-muted-foreground">{p.notes}</div>}
        {p.critique && !p.critique.error && (
          <div className="mt-1 text-[12px]">
            <span className="text-[hsl(var(--sage))]">→ {proposals} proposal{proposals === 1 ? "" : "s"}</span>{" "}
            <span className="text-muted-foreground">· {p.critique.ran_at.slice(0, 16)}</span>
          </div>
        )}
        {p.critique?.error && (
          <div className="mt-1 text-[12px] text-destructive">critique error: {p.critique.error}</div>
        )}
      </div>
      <ChevronRight
        size={14}
        className={cn(
          "text-muted-foreground/60 transition-transform duration-150",
          expanded && "rotate-90",
        )}
        strokeWidth={1.5}
      />
    </div>
  );
}

/**
 * Render the iter's lifecycle phase as a badge. Prefers the canonical `phase`
 * field from the listing; falls back to legacy state+runStatus computation
 * when the listing predates the phase field.
 */
export function PhaseBadge({
  phase,
  fallback,
}: {
  phase?: import("./types").IterPhase;
  fallback: { state: string; runStatus: string | null };
}) {
  const resolved = phase ?? derivePhaseFallback(fallback.state, fallback.runStatus);
  switch (resolved) {
    case "complete":
      return <Badge variant="validated" className="!text-[10px]">complete</Badge>;
    case "abandoned":
      return <Badge variant="outline" className="!text-[10px]">abandoned</Badge>;
    case "awaiting_validation":
      return <Badge variant="warning" className="!text-[10px]">ready · validate</Badge>;
    case "critiquing":
      return <Badge variant="warning" className="!text-[10px]">critiquing…</Badge>;
    case "failed":
      return <Badge variant="warning" className="!text-[10px]">failed</Badge>;
    case "running":
    default:
      return <Badge variant="primary" className="!text-[10px]">running</Badge>;
  }
}

/** Backward-compat shim — same shape as the old StateBadge prop set. */
export function StateBadge({ state, runStatus }: { state: string; runStatus: string | null }) {
  return <PhaseBadge fallback={{ state, runStatus }} />;
}

function derivePhaseFallback(state: string, runStatus: string | null): import("./types").IterPhase {
  if (state === "abandoned") return "abandoned";
  if (state === "complete") return "complete";
  if (state === "ready_to_validate") return "awaiting_validation";
  if (runStatus === "error") return "failed";
  return "running";
}
