// Client-side mirrors of the adherence event types from
// @chart-review/platform-types (client convention — see AdherenceReview.tsx's
// header note on why the client re-declares rather than imports server types).
//
// These lived in EventTimeline.tsx while that component owned the timeline.
// The chronology now renders in the source pane's Timeline tab (TimelineTab),
// so the types moved here rather than staying in a component AdherenceReview
// no longer uses.

export interface RuleEventAnchor {
  type: string; date?: string; end_date?: string;
  origin: "omop" | "note"; ref?: string; meta?: Record<string, unknown>;
}

export interface RuleEvent {
  event_id: string; rule_id: string; anchor: RuleEventAnchor;
  evaluable?: boolean; evaluable_reason?: string;
  answers?: Array<{
    question_id: string; tier: number; answer: string | number | boolean | null;
    /** "agent" | "reviewer" — needed by AdherenceReview's blind-mode
     *  defense-in-depth filter so a reviewer-facing event control is never
     *  seeded from an agent-sourced answer. Optional: legacy/period-only
     *  events predate per-answer provenance. */
    source?: "agent" | "reviewer";
  }>;
  verdict?: "CONCORDANT" | "NON_CONCORDANT" | "EXCLUDED";
  attribution?: string; source?: string; ts?: string;
}

export interface RuleRollup {
  rule_id: string; n_events: number; n_evaluable: number; n_concordant: number;
  n_non_concordant: number; n_excluded: number; rate: number | null;
  period_verdict: "CONCORDANT" | "NON_CONCORDANT" | "EXCLUDED"; period_attribution?: string;
}

/** Whether a rule_event is "anchored" (sits at a specific date) vs a
 *  whole-window rule (anchor.type==="window", which has no place on a
 *  chronology and is shown as a chip instead). An event with a non-window
 *  anchor but no date can't be placed either, so this shared predicate keeps
 *  the timeline and the reviewer's Events list from disagreeing on the count. */
export function isAnchoredEvent(e: Pick<RuleEvent, "anchor">): boolean {
  return e.anchor.type !== "window" && !!e.anchor.date;
}
