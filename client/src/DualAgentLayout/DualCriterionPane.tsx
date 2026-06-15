// DualCriterionPane — side-by-side two-column criterion card.
//
// Visual treatment per docs/superpowers/plans/design-output/dual-agent-ui/LOCKED.md:
//   - 1fr/1px/1fr grid template for the agent body
//   - 3px left-rule: sage when agreement=true, oxblood when agreement=false
//   - Agent name band: uppercase tracked-out caps on slot color
//   - Answer chip color tokens: yes/true → sage bg, no/false → oxblood bg, no_info → slate bg
//   - Evidence block: dashed top border, note-id pill (font-mono), quoted text with 2px left rule
//   - Confidence: mono muted, optional
//   - Rationale: italic 12px
//   - AdjudicationForm rendered below when agreement=false, hidden when true
//   - Collapsed agreed rows: single-line summary, expandable on click (cluster 8 — U12)
//   - QA spot-check badge: ochre "QA spot-check" pill, forces expanded on agreed cells
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { AdjudicationForm } from "./AdjudicationForm";
import type { EvidenceRef, Disagreement, AdjudicationClassification } from "./types";

export interface AgentColumn {
  agentLabel: string; // "Agent 1" / "Agent 2"
  answer: string;
  evidence: EvidenceRef[];
  confidence?: "low" | "medium" | "high";
  rationale?: string;
}

export interface DualCriterionPaneProps {
  fieldId: string;
  fieldPrompt: string;
  agentA: AgentColumn;
  agentB: AgentColumn;
  agreement: boolean;
  /** When true and agreement=true, start in collapsed one-line summary state. */
  initiallyCollapsed?: boolean;
  /** When true (and agreement=true), marks this cell as a QA spot-check.
   *  Forces expanded and shows an ochre "QA spot-check" badge. */
  isQaSpotCheck?: boolean;
  /** Called when the QA spot-check for this row has been "reviewed" (i.e.
   *  expanded and then manually acknowledged). Caller tracks per-field. */
  onQaSpotCheckReviewed?: () => void;
  /** Whether QA spot-check has already been acknowledged by the reviewer. */
  qaSpotCheckReviewed?: boolean;
  initialAdjudication?: {
    classification: AdjudicationClassification;
    suggested_revision?: string;
  };
  onAdjudicate: (a: {
    classification: AdjudicationClassification;
    suggested_revision?: string;
    notes?: string;
  }) => void;
}

// AnswerChip — semantic color tokens from LOCKED.md
// yes/true → sage bg (hsl(140 22% 96%)) with oxblood variant for outline
// no/false → oxblood bg (hsl(354 50% 96%))
// no_info  → slate bg (hsl(220 16% 96%))
function AnswerChip({ answer }: { answer: string }) {
  const norm = answer.toLowerCase();
  const isYes = norm === "yes" || norm === "true";
  const isNo = norm === "no" || norm === "false";

  const chipCls = isYes
    ? "bg-[hsl(140_22%_96%)] text-[hsl(var(--sage))] border-[hsl(var(--sage)/0.4)]"
    : isNo
    ? "bg-[hsl(354_50%_96%)] text-[hsl(var(--oxblood))] border-[hsl(var(--oxblood)/0.4)]"
    : "bg-[hsl(220_16%_96%)] text-[hsl(220_20%_40%)] border-[hsl(220_16%_75%)]";

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono font-[500] border",
        chipCls,
      )}
    >
      {answer}
    </span>
  );
}

// AgentColumnView — single column inside the 1fr/1px/1fr grid
// Agent name band uses slot-color (agent1-band / agent2-band CSS vars) per LOCKED.md
function AgentColumnView({
  col,
  slot,
}: {
  col: AgentColumn;
  slot: "a" | "b";
}) {
  const bandCls =
    slot === "a"
      ? "bg-[hsl(var(--agent1-band,215_35%_35%))] text-white"
      : "bg-[hsl(var(--agent2-band,175_28%_38%))] text-white";

  return (
    <div className="flex flex-col gap-0 min-w-0">
      {/* Agent name band — uppercase tracked-out caps on slot color */}
      <div
        className={cn(
          "px-3 py-1.5 text-[10px] font-[500] uppercase tracking-[0.22em]",
          bandCls,
        )}
      >
        {col.agentLabel}
      </div>

      <div className="px-3 py-2 flex flex-col gap-2">
        {/* Answer chip */}
        <AnswerChip answer={col.answer} />

        {/* Optional confidence */}
        {col.confidence && (
          <span className="text-[10.5px] font-mono text-muted-foreground">
            conf · {col.confidence}
          </span>
        )}

        {/* Optional rationale */}
        {col.rationale && (
          <p className="text-[12px] italic text-muted-foreground leading-snug">
            {col.rationale}
          </p>
        )}

        {/* Evidence block — dashed top border, note-id pills + quoted text */}
        {col.evidence.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-2 border-t border-dashed border-border">
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-muted-foreground">
              Evidence · {col.evidence.length}
            </span>
            <ul className="flex flex-col gap-1.5">
              {col.evidence.map((ev, i) => (
                <li key={i} className="flex flex-col gap-0.5">
                  {/* Note-id pill */}
                  <span className="inline-block w-fit px-1.5 py-0.5 rounded text-[10.5px] font-mono bg-muted text-muted-foreground cursor-pointer hover:bg-muted/80">
                    {ev.note_id}
                  </span>
                  {/* Quoted text with 2px sage left rule */}
                  <span className="pl-2 border-l-2 border-[hsl(var(--sage,140_30%_40%))] text-[11.5px] leading-relaxed text-foreground">
                    &ldquo;{ev.quote}&rdquo;
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export function DualCriterionPane(p: DualCriterionPaneProps) {
  // Collapsed state — only applicable when agreement=true.
  // QA spot-checks start expanded; other agreed cells start collapsed.
  const [collapsed, setCollapsed] = useState<boolean>(
    p.agreement && !p.isQaSpotCheck && (p.initiallyCollapsed ?? true),
  );

  // Build a minimal Disagreement object for AdjudicationForm
  const disagreement: Disagreement = {
    patient_id: "",
    field_id: p.fieldId,
    kind: "hard",
    pair: { agent_a: "agent_a", agent_b: "agent_b" },
    answers: { agent_a: p.agentA.answer, agent_b: p.agentB.answer },
    evidence: { agent_a: p.agentA.evidence, agent_b: p.agentB.evidence },
  };

  // 3px left-rule: sage when agreed, oxblood when not
  const leftRuleColor = p.agreement
    ? "border-l-[hsl(var(--sage,140_30%_40%))]"
    : "border-l-[hsl(var(--oxblood,354_60%_40%))]";

  // ── Collapsed agreed row — one-line summary ──────────────────────────────
  if (p.agreement && collapsed) {
    return (
      <article
        className={cn(
          "flex items-center rounded-md border border-border overflow-hidden",
          "border-l-[3px]",
          leftRuleColor,
          "bg-card cursor-pointer hover:bg-muted/20 transition-colors",
        )}
        onClick={() => setCollapsed(false)}
        role="button"
        aria-expanded="false"
        aria-label={`Expand agreed criterion ${p.fieldId}`}
        data-testid={`criterion-row-${p.fieldId}`}
      >
        <div className="flex flex-1 items-center gap-3 px-4 py-2.5 min-w-0">
          <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
          <span className="text-[12px] font-mono font-[500] text-foreground shrink-0">
            {p.fieldId}
          </span>
          <span className="text-[12px] text-muted-foreground leading-snug truncate">
            {/* checked checkmark */ }
            &#10003; both agents: {p.agentA.answer}
          </span>
          <span className="ml-auto shrink-0 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
            click to expand
          </span>
        </div>
      </article>
    );
  }

  // ── Expanded (disagreement or QA-forced or user-expanded agreed) ─────────
  return (
    <article
      className={cn(
        "flex flex-col rounded-md border border-border overflow-hidden",
        "border-l-[3px]",
        leftRuleColor,
        p.isQaSpotCheck && "ring-1 ring-[hsl(var(--ochre)/0.35)]",
      )}
      data-testid={`criterion-row-${p.fieldId}`}
    >
      {/* Card header — field id + prompt */}
      <header className="px-4 py-2.5 flex items-center gap-3 bg-card">
        <span className="text-[12px] font-mono font-[500] text-foreground shrink-0">
          {p.fieldId}
        </span>
        <span className="text-[12.5px] text-foreground/80 leading-snug flex-1 min-w-0">
          {p.fieldPrompt}
        </span>
        {/* QA spot-check badge */}
        {p.isQaSpotCheck && (
          <span
            className={cn(
              "shrink-0 inline-flex items-center rounded-sm border px-1.5 py-0.5",
              "border-[hsl(var(--ochre)/0.4)] bg-[hsl(var(--ochre)/0.12)]",
              "text-[10px] uppercase tracking-[0.15em] font-semibold text-[hsl(var(--ochre))]",
            )}
          >
            QA spot-check
          </span>
        )}
        {/* Collapse button — only for agreed, non-QA rows */}
        {p.agreement && !p.isQaSpotCheck && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="shrink-0 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors ml-2"
            aria-label="Collapse agreed row"
          >
            <ChevronDown size={12} />
          </button>
        )}
      </header>

      {/* Two-column body: 1fr / 1px divider / 1fr per LOCKED.md */}
      <div
        className="grid bg-card"
        style={{ gridTemplateColumns: "1fr 1px 1fr" }}
      >
        <AgentColumnView col={p.agentA} slot="a" />
        {/* 1px divider column */}
        <div className="bg-border" aria-hidden />
        <AgentColumnView col={p.agentB} slot="b" />
      </div>

      {/* AdjudicationForm — only when disagreement */}
      {!p.agreement && (
        <AdjudicationForm
          disagreement={disagreement}
          initialClassification={p.initialAdjudication?.classification}
          initialRevision={p.initialAdjudication?.suggested_revision}
          onSubmit={p.onAdjudicate}
        />
      )}

      {/* QA spot-check acknowledgement — agreed + QA, not yet reviewed */}
      {p.agreement && p.isQaSpotCheck && !p.qaSpotCheckReviewed && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-t border-border bg-[hsl(var(--ochre)/0.06)]">
          <span className="text-[12px] text-muted-foreground flex-1">
            Both agents agreed. Verify and confirm.
          </span>
          <button
            type="button"
            onClick={p.onQaSpotCheckReviewed}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium",
              "bg-foreground text-background hover:bg-foreground/90 transition-colors",
            )}
          >
            Confirm QA spot-check
          </button>
        </div>
      )}

      {/* QA spot-check confirmed */}
      {p.agreement && p.isQaSpotCheck && p.qaSpotCheckReviewed && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-border bg-[hsl(var(--sage)/0.06)]">
          <span className="text-[11px] text-[hsl(var(--sage))]">
            &#10003; QA spot-check confirmed
          </span>
        </div>
      )}
    </article>
  );
}
