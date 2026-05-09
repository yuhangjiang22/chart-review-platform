// SampleQueue — per-run sample validation queue with inline deployment-κ
// report once enough patients have been validated.
//
// Visual model:
//   • Top: validation progress as a stat block (FigureStats-style scale)
//   • Middle: stacked numbered rows of sampled patients (PilotRow-style)
//   • Bottom: deployment-κ report panel (per-criterion table + overall + Δ)

import { useEffect, useState, useCallback } from "react";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { authFetch } from "../../auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { SampleQueueResponse, SampleQueueEntry, ValidationStatus } from "./types";
import { PatientValidationView } from "./PatientValidationView";

// ── shape mirrors of the deployment-κ report ────────────────────────────────

interface PerCriterionKappa {
  metric_type: "kappa";
  field_id: string;
  kappa: number;
  ci_lower: number;
  ci_upper: number;
  n: number;
  calibration_kappa?: number;
  kappa_gap?: number;
}
interface PerCriterionExactMatch {
  metric_type: "exact_match";
  field_id: string;
  rate: number;
  n_match: number;
  n_total: number;
}
type PerCriterionMetric = PerCriterionKappa | PerCriterionExactMatch;

interface DeploymentKappaReport {
  cohort_id: string;
  run_id: string;
  n_validated_patients: number;
  n_total_sampled: number;
  overall_kappa: number;
  overall_ci: [number, number];
  per_criterion: PerCriterionMetric[];
  computed_at: string;
}

const KAPPA_GAP_WARN = 0.1;

// ── component ────────────────────────────────────────────────────────────────

interface SampleQueueProps {
  cohortId: string;
  runId: string;
  taskId: string;
  blind: boolean;
  onBack: () => void;
}

export function SampleQueue({ cohortId, runId, taskId, blind, onBack }: SampleQueueProps) {
  const [queue, setQueue] = useState<SampleQueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPatient, setSelectedPatient] = useState<string | null>(null);
  const [report, setReport] = useState<DeploymentKappaReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [computingReport, setComputingReport] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    authFetch(`/api/cohorts/${cohortId}/runs/${runId}/sample`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setQueue)
      .catch(() => setQueue(null))
      .finally(() => setLoading(false));
  }, [cohortId, runId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Load persisted report (GET) on mount; if none exists, leave null.
  const loadReport = useCallback(() => {
    setReportError(null);
    authFetch(`/api/cohorts/${cohortId}/runs/${runId}/report`)
      .then(async (r) => {
        if (!r.ok) {
          // 404 or similar — no report yet, that's fine
          setReport(null);
          return;
        }
        const body = await r.json();
        setReport(body as DeploymentKappaReport);
      })
      .catch(() => setReport(null));
  }, [cohortId, runId]);

  useEffect(() => { loadReport(); }, [loadReport]);

  // Recompute & persist (POST) on demand.
  const computeReport = async () => {
    setComputingReport(true);
    setReportError(null);
    try {
      const r = await authFetch(`/api/cohorts/${cohortId}/runs/${runId}/report`, {
        method: "POST",
      });
      if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
      const body = await r.json();
      setReport(body as DeploymentKappaReport);
    } catch (e) {
      setReportError((e as Error).message);
    } finally {
      setComputingReport(false);
    }
  };

  if (selectedPatient) {
    return (
      <PatientValidationView
        cohortId={cohortId}
        runId={runId}
        patientId={selectedPatient}
        taskId={taskId}
        blind={blind}
        onBack={() => {
          setSelectedPatient(null);
          refresh();
          loadReport();
        }}
      />
    );
  }

  if (loading) {
    return <div className="text-[12px] italic text-muted-foreground">loading sample queue…</div>;
  }

  if (!queue) {
    return (
      <div className="rounded-md border border-dashed border-border bg-paper/40 p-8 text-center text-[12.5px] text-muted-foreground">
        No sample drawn for this run yet. Use{" "}
        <code className="font-mono text-[11px]">
          POST /api/cohorts/{cohortId}/runs/{runId}/sample
        </code>{" "}
        to draw a stratified sample.
      </div>
    );
  }

  const allDone = queue.n_validated === queue.n_total && queue.n_total > 0;

  return (
    <div className="animate-fade-in space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft size={13} />
          Back to runs
        </Button>
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Sample queue · run{" "}
          <code className="font-mono text-[10px] normal-case">{runId.slice(0, 20)}</code>
        </div>
      </div>

      {/* Progress summary — matches FigureStats scale (display 34px tabular). */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-x-12 gap-y-3 md:grid-cols-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Validated
            </div>
            <div
              className={cn(
                "mt-1 font-display text-[34px] leading-none tabular-nums",
                allDone
                  ? "text-[hsl(var(--sage))]"
                  : queue.n_validated > 0
                  ? "text-[hsl(var(--oxblood))]"
                  : "text-muted-foreground",
              )}
              style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}
            >
              {queue.n_validated}
              <span className="text-[20px] text-muted-foreground/50"> / {queue.n_total}</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Mode
            </div>
            <div
              className="mt-1 font-display text-[34px] leading-none text-muted-foreground"
              style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}
            >
              {blind ? "blind" : "open"}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Drawn
            </div>
            <div className="mt-1 font-mono text-[12.5px] text-foreground">
              {queue.drawn_at.slice(0, 10)}
            </div>
            <div className="text-[10.5px] text-muted-foreground">{queue.drawn_by}</div>
          </div>
        </div>
        {/* Slim progress bar */}
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-muted/40">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              allDone ? "bg-[hsl(var(--sage))]" : "bg-[hsl(var(--oxblood))]/60",
            )}
            style={{ width: queue.n_total > 0 ? `${(queue.n_validated / queue.n_total) * 100}%` : "0%" }}
          />
        </div>
      </div>

      <Separator />

      {/* Patient list — stacked numbered rows */}
      <div>
        <div className="mb-3 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Patients
        </div>
        <ol className="space-y-0">
          {queue.patients.map((p, idx) => (
            <li key={p.patient_id} className="border-b border-border/60 last:border-b-0">
              <PatientRow
                index={idx + 1}
                entry={p}
                onOpen={() => setSelectedPatient(p.patient_id)}
              />
            </li>
          ))}
        </ol>
      </div>

      <Separator />

      {/* Deployment-κ report panel */}
      <DeploymentKappaPanel
        report={report}
        loading={computingReport}
        error={reportError}
        canCompute={queue.n_validated > 0}
        onCompute={computeReport}
      />
    </div>
  );
}

// ── PatientRow ──────────────────────────────────────────────────────────────

function PatientRow({
  entry,
  index,
  onOpen,
}: {
  entry: SampleQueueEntry;
  index: number;
  onOpen: () => void;
}) {
  const pct =
    entry.n_leaf_criteria > 0
      ? Math.round((entry.n_answered / entry.n_leaf_criteria) * 100)
      : 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full cursor-pointer select-none grid-cols-[40px_1fr_auto_auto] items-baseline gap-5 py-4 text-left transition-colors hover:bg-muted/20"
    >
      <span className="font-display text-[22px] tabular-nums leading-none text-ink/40">
        {String(index).padStart(2, "0")}
      </span>
      <div>
        <div className="flex items-baseline gap-3">
          <code className="font-mono text-[12.5px] text-foreground">{entry.patient_id}</code>
          <Badge variant={statusVariant(entry.validation_status)} className="!text-[10px]">
            {entry.validation_status.replace("_", " ")}
          </Badge>
        </div>
        {entry.n_leaf_criteria > 0 && (
          <div className="mt-1 text-[11.5px] text-muted-foreground tabular-nums">
            {entry.n_answered} of {entry.n_leaf_criteria} criteria answered
          </div>
        )}
      </div>
      <span className="font-mono text-[12.5px] tabular-nums text-muted-foreground">
        {entry.n_leaf_criteria > 0 ? `${pct}%` : "—"}
      </span>
      <ChevronRight size={14} className="text-muted-foreground/60" strokeWidth={1.5} />
    </button>
  );
}

function statusVariant(status: ValidationStatus): "validated" | "warning" | "outline" {
  if (status === "validated") return "validated";
  if (status === "in_progress") return "warning";
  return "outline";
}

// ── DeploymentKappaPanel ────────────────────────────────────────────────────

function DeploymentKappaPanel({
  report,
  loading,
  error,
  canCompute,
  onCompute,
}: {
  report: DeploymentKappaReport | null;
  loading: boolean;
  error: string | null;
  canCompute: boolean;
  onCompute: () => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Deployment κ report
        </div>
        <Button
          variant={report ? "ghost" : "default"}
          size="sm"
          onClick={onCompute}
          disabled={loading || !canCompute}
        >
          <FileText size={12} />
          {loading ? "computing…" : report ? "recompute" : "compute"}
        </Button>
      </div>

      {error && (
        <div className="mb-3 rounded-sm border border-destructive/40 bg-destructive/5 p-3 text-[12px] text-destructive">
          {error}
        </div>
      )}

      {!report && !loading && !error && (
        <div className="rounded-md border border-dashed border-border bg-paper/40 p-6 text-[12px] text-muted-foreground">
          {canCompute
            ? "Compute the report to see per-criterion agent-vs-reviewer agreement plus the calibration-vs-deployment κ gap."
            : "Validate at least one sampled patient before computing the report."}
        </div>
      )}

      {report && <KappaReportTable report={report} />}
    </div>
  );
}

function KappaReportTable({ report }: { report: DeploymentKappaReport }) {
  const flagged = report.per_criterion.filter(
    (c) => c.metric_type === "kappa" && c.kappa_gap !== undefined && Math.abs(c.kappa_gap) > KAPPA_GAP_WARN,
  );

  return (
    <div className="space-y-4">
      {/* Overall band */}
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 rounded-md border border-border bg-card px-5 py-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Overall κ
          </div>
          <div
            className="mt-1 font-display text-[34px] leading-none tabular-nums text-[hsl(var(--oxblood))]"
            style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}
          >
            {isFinite(report.overall_kappa) ? report.overall_kappa.toFixed(2) : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            95% CI
          </div>
          <div className="mt-1 font-mono text-[14px] tabular-nums text-foreground">
            {isFinite(report.overall_ci[0]) && isFinite(report.overall_ci[1])
              ? `${report.overall_ci[0].toFixed(2)} – ${report.overall_ci[1].toFixed(2)}`
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Validated patients
          </div>
          <div className="mt-1 font-mono text-[14px] tabular-nums text-foreground">
            {report.n_validated_patients} / {report.n_total_sampled}
          </div>
        </div>
        {flagged.length > 0 && (
          <Badge variant="warning" className="!text-[10px] self-center">
            {flagged.length} flagged · |Δ| &gt; {KAPPA_GAP_WARN.toFixed(2)}
          </Badge>
        )}
      </div>

      {/* Per-criterion rows */}
      <ol className="space-y-0">
        {report.per_criterion.map((c, idx) => (
          <li key={c.field_id} className="border-b border-border/60 last:border-b-0">
            <CriterionMetricRow row={c} index={idx + 1} />
          </li>
        ))}
      </ol>

      <div className="text-[10.5px] text-muted-foreground">
        Computed {report.computed_at.slice(0, 16)} · 95% CIs use the closed-form Cohen's-κ standard
        error; for n &lt; 30 or extreme κ, bootstrap CIs are more accurate.
      </div>
    </div>
  );
}

function CriterionMetricRow({ row, index }: { row: PerCriterionMetric; index: number }) {
  if (row.metric_type === "exact_match") {
    return (
      <div className="grid grid-cols-[40px_1fr_auto] items-baseline gap-5 py-3">
        <span className="font-display text-[18px] tabular-nums leading-none text-ink/40">
          {String(index).padStart(2, "0")}
        </span>
        <div>
          <div className="flex items-baseline gap-3">
            <code className="font-mono text-[12.5px] text-foreground">{row.field_id}</code>
            <Badge variant="outline" className="!text-[10px]">numeric</Badge>
          </div>
          <div className="mt-1 text-[11.5px] text-muted-foreground tabular-nums">
            exact-match {row.n_match}/{row.n_total}
          </div>
        </div>
        <span className="font-mono text-[14px] tabular-nums text-foreground">
          {isFinite(row.rate) ? `${(row.rate * 100).toFixed(0)}%` : "—"}
        </span>
      </div>
    );
  }

  const flagged = row.kappa_gap !== undefined && Math.abs(row.kappa_gap) > KAPPA_GAP_WARN;
  const gapSign = row.kappa_gap !== undefined && row.kappa_gap >= 0 ? "+" : "";

  return (
    <div className="grid grid-cols-[40px_1fr_auto_auto] items-baseline gap-5 py-3">
      <span className="font-display text-[18px] tabular-nums leading-none text-ink/40">
        {String(index).padStart(2, "0")}
      </span>
      <div>
        <div className="flex flex-wrap items-baseline gap-3">
          <code className="font-mono text-[12.5px] text-foreground">{row.field_id}</code>
          <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
            n = {row.n}
          </span>
          {flagged && (
            <Badge variant="warning" className="!text-[10px]">
              Δ {gapSign}
              {row.kappa_gap!.toFixed(2)}
            </Badge>
          )}
        </div>
        {row.calibration_kappa !== undefined && (
          <div className="mt-1 text-[11.5px] text-muted-foreground tabular-nums">
            calibration κ {row.calibration_kappa.toFixed(2)}
            {row.kappa_gap !== undefined && (
              <>
                {" "}
                <span className="text-muted-foreground/50">·</span> Δ {gapSign}
                {row.kappa_gap.toFixed(2)}
              </>
            )}
          </div>
        )}
      </div>
      <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
        ({row.ci_lower.toFixed(2)}, {row.ci_upper.toFixed(2)})
      </span>
      <span
        className={cn(
          "font-mono text-[14px] tabular-nums",
          flagged ? "text-[hsl(var(--oxblood))]" : "text-foreground",
        )}
      >
        {isFinite(row.kappa) ? row.kappa.toFixed(2) : "—"}
      </span>
    </div>
  );
}
