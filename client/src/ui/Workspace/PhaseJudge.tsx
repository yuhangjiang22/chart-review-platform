// PhaseJudge — optional pre-screening phase between TRY and VALIDATE.
//
// Hosts the LLM-as-judge batch trigger + status. The judge analyzes
// disagreements + low-confidence cells + type-drift cells (phenotype)
// OR span disagreements + novel_candidate spans (NER), writes
// <task>/pilots/<iter>/judge_analyses.json with a task_kind discriminator,
// and PatientReview / SpanReview read that file to surface advisory
// panels.
//
// task_kind branching (Phase 4.2):
//   - phenotype tasks: status panel only; records render in PatientReview
//   - ner tasks:       status panel + inline list of span analysis records
//                      (since SpanReview doesn't yet have a judge-panel)
//
// This phase is OPTIONAL — reviewers who want to validate without
// LLM pre-screening simply navigate past it.

import { useEffect, useState } from "react";
import { ArrowRight, Sparkles, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PhaseJudgeProps {
  taskId: string;
  /** Iter the judge analyses against. Same iter the VALIDATE phase will
   *  surface the analyses on. */
  iterId: string;
  /** Skip-to-validate affordance — navigates the workspace to VALIDATE
   *  without running the judge. */
  onSkipToValidate: () => void;
  /** Active task_kind. Drives whether the panel renders span-record cards
   *  inline (NER) or just the summary (phenotype, which has its own
   *  per-criterion advisory rendering in PatientReview). */
  taskKind?: "phenotype" | "ner";
  /** Optional callback when the reviewer clicks a span_id in an NER
   *  analysis card — opens the patient page filtered to that span. */
  onOpenSpan?: (patientId: string, spanId: string) => void;
}

interface JudgeStatus {
  running: boolean;
  cellsAnalyzed?: number;
  cellsFailed?: number;
  generatedAt?: string;
  totalCostUsd?: number;
  taskKindFromFile?: "phenotype" | "ner";
  analyses?: NerJudgeRecord[];
}

interface SpanSnap {
  agent_id: string;
  note_id: string;
  text: string;
  anchor: string;
  start: number;
  end: number;
  entity_type: string;
  concept_name: string;
  status?: "mapped" | "novel_candidate" | "rejected";
}

interface NerJudgeRecord {
  patient_id: string;
  span_id: string;
  note_id: string;
  entity_type: string;
  kind: string;
  agent_a: SpanSnap | null;
  agent_b?: SpanSnap | null;
  analysis?: {
    suggested_concept_name: string;
    suggested_entity_type: string;
    suggested_status: "mapped" | "novel_candidate" | "rejected";
    reasoning: string;
    agent_correctness: string;
    classification_hint: string;
    judge_confidence: "low" | "medium" | "high";
  };
  error?: string;
}

export function PhaseJudge({
  taskId, iterId, onSkipToValidate, taskKind, onOpenSpan,
}: PhaseJudgeProps) {
  const [status, setStatus] = useState<JudgeStatus>({ running: false });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const r = await authFetch(
        `/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/judge`,
      );
      if (!r.ok || cancelled) return;
      const body = await r.json();
      if (cancelled) return;
      setStatus({
        running: !!body.running,
        cellsAnalyzed:
          typeof body.cells_analyzed === "number" ? body.cells_analyzed : undefined,
        cellsFailed:
          typeof body.cells_failed === "number" ? body.cells_failed : undefined,
        generatedAt:
          typeof body.generated_at === "string" ? body.generated_at : undefined,
        totalCostUsd:
          typeof body.total_cost_usd === "number" ? body.total_cost_usd : undefined,
        taskKindFromFile: body.task_kind === "ner" ? "ner" : "phenotype",
        analyses: Array.isArray(body.analyses) ? (body.analyses as NerJudgeRecord[]) : undefined,
      });
    }
    load();
    // Poll while running so the button reflects completion without a refresh.
    const handle = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [taskId, iterId]);

  async function runJudge() {
    setStatus((s) => ({ ...s, running: true }));
    const r = await authFetch(
      `/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/judge`,
      { method: "POST" },
    );
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(`Could not start judge: ${body.error ?? r.status}`);
      setStatus((s) => ({ ...s, running: false }));
    }
    // Poll picks up the running flag + completion automatically.
  }

  const hasResults = !!status.generatedAt;
  const isNer = taskKind === "ner" || status.taskKindFromFile === "ner";
  const unitLabel = isNer ? "span" : "cell";
  const unitLabelPlural = isNer ? "spans" : "cells";

  return (
    <div className="pt-2 space-y-4">
      <div className="rounded-md border border-border bg-card p-4">
        <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Optional pre-screening
        </div>
        <h3 className="text-[14px] font-medium text-foreground mb-1">
          LLM-as-judge: pre-screen {isNer ? "span disagreements" : "disagreements"} before reviewer adjudication
        </h3>
        <p className="text-[12px] text-muted-foreground leading-snug max-w-prose">
          {isNer ? (
            <>
              A more capable model reviews each span where the two agents
              disagreed (hard / boundary / type / miss) or where one agent
              flagged a span as <code>novel_candidate</code>. The output is
              advisory — the reviewer still adjudicates in SpanReview — but
              it suggests a concept_name, entity_type, and resolution.
            </>
          ) : (
            <>
              A more capable model reviews each (patient, criterion) cell
              where the two agents disagreed, where one agent reported low
              confidence, or where they emitted different value formats. The
              output is advisory — the reviewer still adjudicates in
              VALIDATE — but it pre-fills the suggested answer + reasoning +
              evidence pointers.
            </>
          )}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="default"
            className="gap-1.5"
            onClick={runJudge}
            disabled={status.running}
            aria-label="Run judge analysis"
          >
            {status.running ? (
              <>
                <Loader2 size={12} strokeWidth={1.75} className="animate-spin" />
                Judge running…
              </>
            ) : hasResults ? (
              <>
                <Sparkles size={12} strokeWidth={1.75} />
                Re-run judge ({status.cellsAnalyzed ?? 0} {unitLabelPlural})
              </>
            ) : (
              <>
                <Sparkles size={12} strokeWidth={1.75} />
                Run judge analysis
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={onSkipToValidate}
          >
            {hasResults ? "Continue to validate" : "Skip — go straight to validate"}
            <ArrowRight size={12} strokeWidth={1.75} />
          </Button>
        </div>

        {status.generatedAt && !status.running && (
          <div className="mt-3 text-[11px] text-muted-foreground border-t border-border/50 pt-2">
            <div>
              <span className="font-medium text-foreground">
                {status.cellsAnalyzed ?? 0}
              </span>{" "}
              {unitLabelPlural} analyzed
              {status.cellsFailed ? (
                <>
                  {" · "}
                  <span className="text-[hsl(var(--oxblood))]">
                    {status.cellsFailed} failed
                  </span>
                </>
              ) : null}
              {typeof status.totalCostUsd === "number" ? (
                <>
                  {" · "}${status.totalCostUsd.toFixed(2)}
                </>
              ) : null}
            </div>
            <div className="mt-0.5 text-muted-foreground/70">
              Generated {new Date(status.generatedAt).toLocaleString()}
            </div>
          </div>
        )}
      </div>

      {/* NER-specific: render inline analysis cards. Phenotype tasks
       *  rely on PatientReview's per-criterion advisory pane instead. */}
      {isNer && hasResults && Array.isArray(status.analyses) && status.analyses.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Per-span analyses
          </div>
          {status.analyses.map((rec) => (
            <NerJudgeCard
              key={`${rec.patient_id}::${rec.span_id}`}
              record={rec}
              onOpenSpan={onOpenSpan}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NerJudgeCard({
  record, onOpenSpan,
}: {
  record: NerJudgeRecord;
  onOpenSpan?: (patientId: string, spanId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const a = record.analysis;
  const failed = !a && !!record.error;
  const headlineBg = failed
    ? "bg-red-50 border-red-200"
    : a?.suggested_status === "rejected"
      ? "bg-red-50 border-red-200"
      : a?.suggested_status === "novel_candidate"
        ? "bg-amber-50 border-amber-200"
        : "bg-green-50 border-green-200";
  return (
    <div className={cn("border rounded-md", headlineBg, "border-l-4")}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="w-full px-3 py-2 flex items-start gap-2 text-left text-[12px] hover:bg-muted/30 rounded-md"
      >
        {open ? <ChevronDown className="size-3.5 mt-0.5" /> : <ChevronRight className="size-3.5 mt-0.5" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-mono text-[11px]">{record.span_id.slice(0, 10)}</span>
            <span className="text-muted-foreground">·</span>
            <span>{record.entity_type}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {record.kind}
            </span>
            <span className="text-muted-foreground ml-auto text-[10px]">
              patient: {record.patient_id}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
            {failed
              ? `error: ${record.error}`
              : a
                ? `suggested: ${a.suggested_concept_name || "(novel)"} → ${a.suggested_status} · ${a.classification_hint} · ${a.judge_confidence}`
                : "(no analysis)"}
          </div>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-current/10 space-y-2 text-[11.5px]">
          <SpanAgentBlock label="Agent A" snap={record.agent_a} />
          {record.agent_b && <SpanAgentBlock label="Agent B" snap={record.agent_b} />}
          {a && (
            <div className="space-y-1 pt-1">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                Judge analysis
              </div>
              <div className="text-[11.5px] leading-snug">{a.reasoning}</div>
              <div className="text-[10.5px] text-muted-foreground">
                agent_correctness: <span className="font-mono">{a.agent_correctness}</span>
                {"  ·  "}classification: <span className="font-mono">{a.classification_hint}</span>
                {"  ·  "}confidence: <span className="font-mono">{a.judge_confidence}</span>
              </div>
            </div>
          )}
          {onOpenSpan && (
            <Button
              size="sm" variant="outline"
              onClick={() => onOpenSpan(record.patient_id, record.span_id)}
            >
              Open in SpanReview <ArrowRight className="size-3" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function SpanAgentBlock({ label, snap }: { label: string; snap: SpanSnap | null }) {
  if (!snap) {
    return (
      <div className="border-l-2 border-border/50 pl-2 text-muted-foreground italic">
        {label}: (no span at this location)
      </div>
    );
  }
  return (
    <div className="border-l-2 border-border/60 pl-2">
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">{label} · {snap.agent_id}</div>
      <div className="font-mono text-[11px]">
        [{snap.start},{snap.end}) in {snap.note_id}: {JSON.stringify(snap.text)} (anchor: {JSON.stringify(snap.anchor)})
      </div>
      <div className="text-[11px]">{snap.entity_type} → {snap.concept_name || "(novel)"} <span className="text-muted-foreground">[{snap.status ?? "mapped"}]</span></div>
    </div>
  );
}
