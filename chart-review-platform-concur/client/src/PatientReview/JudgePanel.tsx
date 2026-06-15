// JudgePanel — surfaces the LLM-as-judge analysis for the active criterion
// in the per-patient review form. Renders inline above the CriterionCard
// when a judge analysis exists for this (patient, field). Read-only,
// advisory; the reviewer still adjudicates.
//
// Data source: GET /api/pilots/:taskId/:iterId/judge → JudgeAnalysesFile.
// PatientReview fetches the file once per (taskId, iterId) and passes the
// matching analysis record into this component.

import { Sparkles, AlertCircle, ArrowRight, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Mirror of the server-side JudgeAnalysisRecord; duplicated here so the
 *  client doesn't import server types. Keep in sync with judge-batch.ts. */
export interface JudgeEvidencePointer {
  note_id: string;
  what_to_look_for: string;
  offsets?: [number, number] | null;
}

export interface JudgeAnalysis {
  suggested_answer: unknown;
  reasoning: string;
  evidence_pointers: JudgeEvidencePointer[];
  agent_correctness: "agent_a" | "agent_b" | "neither" | "both" | "n_a";
  classification_hint:
    | "guideline_gap"
    | "agent_a_error"
    | "agent_b_error"
    | "true_ambiguity"
    | "n_a";
  judge_confidence: "low" | "medium" | "high";
}

/** Per-agent snapshot — minimal subset needed by the client (agent_id is
 *  used to look up the matching AgentFieldDraft when the reviewer clicks
 *  Apply). The server file carries more fields, but JudgePanel only needs
 *  the id. */
export interface JudgeAgentRef {
  agent_id: string;
}

export interface JudgeAnalysisRecord {
  patient_id: string;
  field_id: string;
  kind: "disagreement" | "low_confidence" | "type_drift";
  agent_a: JudgeAgentRef;
  agent_b?: JudgeAgentRef;
  analysis?: JudgeAnalysis;
  error?: string;
  cost_usd?: number;
  generated_at: string;
}

interface JudgePanelProps {
  record: JudgeAnalysisRecord;
  /** Click on an evidence pointer → jump the notes pane to that span. */
  onJumpToNote?: (noteId: string, offsets?: [number, number] | null) => void;
  /** Click on "Apply suggestion" → commit the judge's suggested answer
   *  using evidence from the agent the judge identified as correct.
   *  `agentIdToCopyFrom` is null when the judge said neither agent was
   *  right (the caller may submit with empty evidence + the judge's
   *  reasoning as rationale). When this prop is omitted, the Apply
   *  button is hidden. */
  onApply?: (suggestedAnswer: unknown, agentIdToCopyFrom: string | null) => void;
  /** Disabled state for the Apply button (e.g. record is locked). */
  applyDisabled?: boolean;
}

const KIND_LABEL: Record<JudgeAnalysisRecord["kind"], string> = {
  disagreement: "Agents disagreed",
  low_confidence: "Low-confidence answer",
  type_drift: "Format mismatch",
};

/** Per-kind container styling. type_drift is calmer (muted border, no accent
 *  fill) — it's a data-quality canary, not a clinical disagreement. */
const KIND_CONTAINER_CLASS: Record<JudgeAnalysisRecord["kind"], string> = {
  disagreement:
    "border-[hsl(var(--accent))]/40 bg-[hsl(var(--accent))]/5",
  low_confidence:
    "border-[hsl(var(--accent))]/40 bg-[hsl(var(--accent))]/5",
  type_drift: "border-border bg-muted/30",
};

/** Icon tint follows the container. type_drift uses muted-foreground to
 *  signal "informational" rather than "needs your judgement." */
const KIND_ICON_CLASS: Record<JudgeAnalysisRecord["kind"], string> = {
  disagreement: "text-[hsl(var(--accent))]",
  low_confidence: "text-[hsl(var(--accent))]",
  type_drift: "text-muted-foreground",
};

const CONFIDENCE_TONE: Record<JudgeAnalysis["judge_confidence"], string> = {
  high: "text-[hsl(var(--sage))]",
  medium: "text-[hsl(var(--gold,45_70%_45%))]",
  low: "text-muted-foreground",
};

const HINT_LABEL: Record<JudgeAnalysis["classification_hint"], string> = {
  guideline_gap: "guideline gap",
  agent_a_error: "agent A error",
  agent_b_error: "agent B error",
  true_ambiguity: "true ambiguity",
  n_a: "—",
};

export function JudgePanel({ record, onJumpToNote, onApply, applyDisabled }: JudgePanelProps) {
  if (record.error || !record.analysis) {
    return (
      <div className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <AlertCircle size={12} />
          <span>Judge could not analyze this cell{record.error ? `: ${record.error}` : ""}.</span>
        </div>
      </div>
    );
  }

  const a = record.analysis;
  const suggested =
    a.suggested_answer === null || a.suggested_answer === undefined
      ? "(ambiguous)"
      : typeof a.suggested_answer === "string"
        ? a.suggested_answer
        : JSON.stringify(a.suggested_answer);

  return (
    <div className={cn("mb-3 rounded-md border px-4 py-3", KIND_CONTAINER_CLASS[record.kind])}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-foreground">
          <Sparkles size={12} className={KIND_ICON_CLASS[record.kind]} />
          <span>Judge analysis</span>
          <Badge variant="outline" className="ml-1 text-[10px] font-normal">
            {KIND_LABEL[record.kind]}
          </Badge>
        </div>
        <div className={cn("text-[10px] uppercase tracking-wide", CONFIDENCE_TONE[a.judge_confidence])}>
          {a.judge_confidence} conf
        </div>
      </div>

      <div className="mb-2 flex items-center gap-2 text-[12px]">
        <span className="text-muted-foreground">suggests:</span>
        <code className="rounded bg-background px-1.5 py-0.5 text-[12px] font-mono text-foreground">
          {suggested}
        </code>
        {record.kind === "disagreement" && a.classification_hint !== "n_a" && (
          <>
            <ArrowRight size={10} className="text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">{HINT_LABEL[a.classification_hint]}</span>
          </>
        )}
      </div>

      <p className="mb-2 text-[12px] leading-snug text-foreground/90">{a.reasoning}</p>

      {a.evidence_pointers.length > 0 && (
        <div className="border-t border-border/50 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            What to verify
          </div>
          <ul className="space-y-0.5">
            {a.evidence_pointers.map((p, i) => (
              <li key={i} className="text-[11px] leading-snug">
                <button
                  type="button"
                  onClick={() => onJumpToNote?.(p.note_id, p.offsets)}
                  className={cn(
                    "text-left hover:underline",
                    onJumpToNote ? "cursor-pointer text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span className="font-mono text-[10px] text-muted-foreground">{p.note_id}</span>
                  {" — "}
                  <span>{p.what_to_look_for}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {onApply && a.suggested_answer !== null && a.suggested_answer !== undefined && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-3">
          <div className="text-[10px] text-muted-foreground">
            {(() => {
              const ac = a.agent_correctness;
              if (ac === "agent_a") return `will copy ${record.agent_a.agent_id}'s evidence + rationale`;
              if (ac === "agent_b" && record.agent_b)
                return `will copy ${record.agent_b.agent_id}'s evidence + rationale`;
              if (ac === "both") return "agents agree — will copy either agent's evidence";
              if (ac === "neither") return "judge says neither agent was right — will commit with empty evidence";
              return "applies the judge's suggestion as your answer";
            })()}
          </div>
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={applyDisabled}
            className="gap-1.5"
            onClick={() => {
              const ac = a.agent_correctness;
              const agentId =
                ac === "agent_a"
                  ? record.agent_a.agent_id
                  : ac === "agent_b" && record.agent_b
                    ? record.agent_b.agent_id
                    : ac === "both"
                      ? record.agent_a.agent_id // either is fine when both agree
                      : ac === "n_a"
                        ? record.agent_a.agent_id // single-agent low-confidence
                        : null; // "neither" — no agent to copy from
              onApply(a.suggested_answer, agentId);
            }}
          >
            <Check size={12} strokeWidth={1.75} />
            Apply: {suggested}
          </Button>
        </div>
      )}
    </div>
  );
}
