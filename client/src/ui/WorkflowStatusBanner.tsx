// WorkflowStatusBanner — live status panel above every Studio tab.
//
// Shows:
//   · guideline version + maturity stage (one line)
//   · the current pilot iter's progress (patients run / validated, revisits)
//   · primary CTA to dig in
//
// Replaces the older lifecycle-staircase + next-action surface. The
// staircase was static eyebrow chrome; the next-action sentence was a
// derivation of state without showing the state. This component shows
// the state directly.
//
// Data sources (all existing endpoints):
//   GET /api/guidelines/:taskId/maturity                       → maturity state
//   GET /api/pilots/:taskId                                    → list of iters
//   GET /api/pilots/:taskId/:iterId                            → patient_status[]
//   GET /api/pilots/:taskId/:iterId/revisits                   → revisit count

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { authFetch } from "../auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type MaturityState = "draft" | "piloted" | "calibrated" | "locked";

interface MaturityResponse {
  state?: MaturityState;
}

interface PilotIterationListing {
  iter_id: string;
  iter_num: number;
  guideline_sha: string;
  state: "running" | "ready_to_validate" | "complete" | "abandoned";
  auto_critique_state?: "running" | "failed" | null;
}

interface PilotIterPatientStatus {
  patient_id: string;
  agent_done: boolean;
  oracle_done: boolean;
  in_progress: boolean;
}

interface PilotIterDetail {
  manifest: PilotIterationListing & { run_id: string };
  patient_status: PilotIterPatientStatus[];
}

interface RevisitsResponse {
  ok: boolean;
  total?: number;
  criteria_changed?: number;
}

export type StudioTabTarget =
  | "guideline"
  | "pilots"
  | "rules"
  | "calibration"
  | "cohorts"
  | "issues"
  | "methods"
  | "bundles";

interface WorkflowStatusBannerProps {
  taskId: string;
  /** Manual version of the compiled task — surfaced as a `vX.Y` tag. */
  manualVersion?: string | null;
  /** Current SHA of the active guideline (kept for back-compat; unused). */
  guidelineSha?: string | null;
  onNavigate: (tab: StudioTabTarget) => void;
}

const STAGE_LABEL: Record<MaturityState, string> = {
  draft: "draft",
  piloted: "piloted",
  calibrated: "calibrated",
  locked: "locked",
};

function pickActiveIter(pilots: PilotIterationListing[]): PilotIterationListing | null {
  // Most recently started, non-abandoned iter. Prefer running > ready_to_validate > complete.
  const candidates = pilots.filter((p) => p.state !== "abandoned");
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => b.iter_num - a.iter_num);
  return sorted[0];
}

export function WorkflowStatusBanner({
  taskId,
  manualVersion,
  onNavigate,
}: WorkflowStatusBannerProps) {
  const [maturity, setMaturity] = useState<MaturityResponse | null>(null);
  const [pilots, setPilots] = useState<PilotIterationListing[]>([]);
  const [iterDetail, setIterDetail] = useState<PilotIterDetail | null>(null);
  const [revisits, setRevisits] = useState<RevisitsResponse | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`workflow-banner-collapsed:${taskId}`) === "1";
    } catch {
      return false;
    }
  });

  const refresh = useCallback(async () => {
    const [m, p] = await Promise.all([
      authFetch(`/api/guidelines/${encodeURIComponent(taskId)}/maturity`)
        .then((res) => (res.ok ? (res.json() as Promise<MaturityResponse>) : null))
        .catch(() => null),
      authFetch(`/api/pilots/${encodeURIComponent(taskId)}`)
        .then((res) => (res.ok ? (res.json() as Promise<PilotIterationListing[]>) : []))
        .catch(() => [] as PilotIterationListing[]),
    ]);
    setMaturity(m);
    setPilots(p ?? []);

    const active = pickActiveIter(p ?? []);
    if (!active) {
      setIterDetail(null);
      setRevisits(null);
      return;
    }
    const [detail, rev] = await Promise.all([
      authFetch(`/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(active.iter_id)}`)
        .then((res) => (res.ok ? (res.json() as Promise<PilotIterDetail>) : null))
        .catch(() => null),
      authFetch(`/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(active.iter_id)}/revisits`)
        .then((res) => (res.ok ? (res.json() as Promise<RevisitsResponse>) : null))
        .catch(() => null),
    ]);
    setIterDetail(detail);
    setRevisits(rev);
  }, [taskId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(`workflow-banner-collapsed:${taskId}`, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const activeIter = useMemo(() => pickActiveIter(pilots), [pilots]);
  const counts = useMemo(() => {
    if (!iterDetail) return null;
    const total = iterDetail.patient_status.length;
    const agent_done = iterDetail.patient_status.filter((s) => s.agent_done).length;
    const validated = iterDetail.patient_status.filter((s) => s.oracle_done).length;
    const in_progress = iterDetail.patient_status.filter((s) => s.in_progress).length;
    return { total, agent_done, validated, in_progress };
  }, [iterDetail]);

  const stage = maturity?.state ?? "draft";
  const versionTag = manualVersion ? `v${manualVersion}` : null;

  return (
    <section className="rounded-md border border-border bg-card/70 p-4">
      {/* Header — guideline · version · stage + collapse */}
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2 text-[13px]">
          <span className="font-display text-[15px] font-medium tracking-tight text-foreground">
            Guideline
          </span>
          {versionTag && (
            <code className="font-mono text-[12px] text-ink">{versionTag}</code>
          )}
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10.5px] uppercase tracking-[0.18em]",
              stage === "locked"
                ? "border-[hsl(var(--sage))]/40 bg-[hsl(var(--sage))]/10 text-[hsl(var(--sage))]"
                : "border-[hsl(var(--oxblood))]/40 bg-[hsl(var(--oxblood))]/10 text-[hsl(var(--oxblood))]",
            )}
          >
            {STAGE_LABEL[stage]}
          </span>
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          title={collapsed ? "Show iter status" : "Hide"}
        >
          {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          {collapsed ? "details" : "hide"}
        </button>
      </div>

      {!collapsed && (
        <div className="mt-3 space-y-3">
          <NextStepHint
            stage={stage}
            iter={activeIter}
            counts={counts}
            revisitsTotal={revisits?.total ?? 0}
            hasAnyIter={pilots.length > 0}
            onNavigate={onNavigate}
          />
          {activeIter && counts ? (
            <ActiveIterPanel
              iter={activeIter}
              counts={counts}
              revisitsTotal={revisits?.total ?? 0}
              onOpenPilots={() => onNavigate("pilots")}
            />
          ) : (
            <NoIterPanel
              stage={stage}
              hasAnyIter={pilots.length > 0}
              onOpenPilots={() => onNavigate("pilots")}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ── Next-step derivation ────────────────────────────────────────────────────

interface NextStep {
  message: string;
  cta?: { label: string; tab: StudioTabTarget };
  /** When true, the hint is informational (no urgent CTA) and renders muted. */
  informational?: boolean;
}

function deriveNextStep(args: {
  stage: MaturityState;
  iter: PilotIterationListing | null;
  counts: { total: number; agent_done: number; validated: number; in_progress: number } | null;
  revisitsTotal: number;
  hasAnyIter: boolean;
}): NextStep {
  const { stage, iter, counts, revisitsTotal, hasAnyIter } = args;

  // 1. Revisits always win — they mean prior GT may be wrong RIGHT NOW.
  if (revisitsTotal > 0) {
    return {
      message: `Resolve ${revisitsTotal} open revisit${revisitsTotal === 1 ? "" : "s"} — recent guideline edits may have invalidated prior answers.`,
      cta: { label: "Open revisits", tab: "pilots" },
    };
  }

  // 2. No iter exists yet — the user is at the very beginning.
  if (!iter) {
    if (stage === "locked") {
      return {
        message: "Guideline is locked. Deploy to a cohort to start production review.",
        cta: { label: "Open Cohorts", tab: "cohorts" },
      };
    }
    return {
      message: hasAnyIter
        ? "No iter currently running. Start a new pilot iter to keep refining."
        : "No iters yet. Start your first pilot iter to evaluate the rubric.",
      cta: { label: "Open Pilots", tab: "pilots" },
    };
  }

  // 3. Iter awaiting validation — the rerun is done, methodologist's turn.
  if (iter.state === "ready_to_validate") {
    return {
      message: `Iter #${iter.iter_num} is ready. Validate the patients to graduate this iter.`,
      cta: { label: "Open Pilots", tab: "pilots" },
    };
  }

  // 4. Iter running — sometimes the agent has finished some patients already.
  if (iter.state === "running") {
    if (counts && counts.agent_done > counts.validated) {
      const ready = counts.agent_done - counts.validated;
      return {
        message: `${ready} patient${ready === 1 ? "" : "s"} ready for validation while the agent finishes the rest.`,
        cta: { label: "Open Pilots", tab: "pilots" },
      };
    }
    return {
      message: `Iter #${iter.iter_num} is running. The agent is reading charts — usually a few minutes per patient.`,
      informational: true,
    };
  }

  // 5. Iter complete but maturity not locked — propose calibration / next iter.
  if (iter.state === "complete") {
    if (stage === "draft") {
      return {
        message: `Iter #${iter.iter_num} is complete. Start another iter to keep refining, or run calibration.`,
        cta: { label: "Open Calibration", tab: "calibration" },
      };
    }
    if (stage === "piloted") {
      return {
        message: "Pilots complete. Run calibration to measure inter-rater agreement.",
        cta: { label: "Open Calibration", tab: "calibration" },
      };
    }
    if (stage === "calibrated") {
      return {
        message: "Calibrated. Run the lock test on the lock cohort to ship.",
        cta: { label: "Open Cohorts", tab: "cohorts" },
      };
    }
  }

  // Fallback: should rarely hit.
  return {
    message: `Iter #${iter.iter_num} · ${iter.state}.`,
    informational: true,
  };
}

function NextStepHint(props: {
  stage: MaturityState;
  iter: PilotIterationListing | null;
  counts: { total: number; agent_done: number; validated: number; in_progress: number } | null;
  revisitsTotal: number;
  hasAnyIter: boolean;
  onNavigate: (tab: StudioTabTarget) => void;
}) {
  const step = deriveNextStep({
    stage: props.stage,
    iter: props.iter,
    counts: props.counts,
    revisitsTotal: props.revisitsTotal,
    hasAnyIter: props.hasAnyIter,
  });
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-md border px-3 py-2",
        step.informational
          ? "border-border bg-paper/40"
          : "border-[hsl(var(--oxblood))]/30 bg-[hsl(var(--oxblood))]/[0.04]",
      )}
    >
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-[10px] uppercase tracking-[0.18em]",
            step.informational ? "text-muted-foreground" : "text-[hsl(var(--oxblood))]",
          )}
        >
          Next step
        </div>
        <div className="mt-0.5 text-[13px] leading-snug text-foreground">{step.message}</div>
      </div>
      {step.cta && (
        <Button
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={() => props.onNavigate(step.cta!.tab)}
        >
          {step.cta.label}
          <ArrowRight size={12} strokeWidth={1.75} />
        </Button>
      )}
    </div>
  );
}

// ── Subviews ────────────────────────────────────────────────────────────────

function ActiveIterPanel({
  iter,
  counts,
  revisitsTotal,
  onOpenPilots,
}: {
  iter: PilotIterationListing;
  counts: { total: number; agent_done: number; validated: number; in_progress: number };
  revisitsTotal: number;
  onOpenPilots: () => void;
}) {
  const stateLabel: Record<PilotIterationListing["state"], string> = {
    running: "running",
    ready_to_validate: "awaiting validation",
    complete: "complete",
    abandoned: "abandoned",
  };
  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        Iter #{iter.iter_num} · {stateLabel[iter.state]}
      </div>
      <dl className="space-y-2">
        <ProgressRow
          label="Patients run"
          done={counts.agent_done}
          total={counts.total}
        />
        <ProgressRow
          label="Patients validated"
          done={counts.validated}
          total={counts.total}
          accent
        />
        {revisitsTotal > 0 && (
          <CountRow
            label="Revisits open"
            value={revisitsTotal}
            ctaLabel="Open"
            onClick={onOpenPilots}
          />
        )}
      </dl>
      <div>
        <Button size="sm" className="gap-1.5" onClick={onOpenPilots}>
          View iter progress
          <ArrowRight size={12} strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}

function NoIterPanel({
  stage,
  hasAnyIter,
  onOpenPilots,
}: {
  stage: MaturityState;
  hasAnyIter: boolean;
  onOpenPilots: () => void;
}) {
  const message =
    stage === "locked"
      ? "Guideline is locked. New iters paused."
      : hasAnyIter
        ? "No iter running. Start a new one to continue refining."
        : "No iters yet. Start the first pilot iter to begin.";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1 text-[13px] text-muted-foreground">{message}</div>
      <Button size="sm" className="gap-1.5" onClick={onOpenPilots}>
        Open Pilots
        <ArrowRight size={12} strokeWidth={1.75} />
      </Button>
    </div>
  );
}

function ProgressRow({
  label,
  done,
  total,
  accent = false,
}: {
  label: string;
  done: number;
  total: number;
  accent?: boolean;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="grid grid-cols-[140px_1fr_auto] items-center gap-3 text-[12.5px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            accent
              ? "bg-[hsl(var(--oxblood))]"
              : "bg-[hsl(var(--sage))]",
          )}
          style={{ width: `${pct}%` }}
        />
      </dd>
      <dd className="font-mono tabular-nums text-foreground">
        {done} / {total}
      </dd>
    </div>
  );
}

function CountRow({
  label,
  value,
  ctaLabel,
  onClick,
}: {
  label: string;
  value: number;
  ctaLabel: string;
  onClick: () => void;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr_auto] items-center gap-3 text-[12.5px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums text-[hsl(var(--ochre))]">{value}</dd>
      <dd>
        <button
          type="button"
          onClick={onClick}
          className="rounded-sm border border-[hsl(var(--ochre))]/40 px-2 py-0.5 text-[11px] text-[hsl(var(--ochre))] hover:bg-[hsl(var(--ochre))]/10"
        >
          {ctaLabel}
        </button>
      </dd>
    </div>
  );
}
