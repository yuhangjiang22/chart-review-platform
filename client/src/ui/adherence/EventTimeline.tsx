// EventTimeline — vertical chronology of the patient's days of care.
//
// Newest first, grouped by month, with a date/offset gutter and a rail — the
// same shape as the source-data Timeline tab (client/src/TimelineTab.tsx),
// which the study lead picked over the earlier horizontal axis. The horizontal
// version placed variable-height cards absolutely in lanes above and below an
// axis; the cards overran their lanes and covered the axis, and the collision
// math got worse with every rule added.
//
// Presentational only: no fetching, no review-state writes. Three modes:
//   review  — verdict-colored cards + window-rule chips + composite header
//   blind   — same geometry, NO verdicts/rates anywhere (gold collection)
//   compare — per-event agent-vs-human verdict chip pairs + enumeration flags
// ALL user-facing text is English (multi-site team; spec decision 7).
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  deriveWindow, groupByOccurrence, groupOccurrencesByMonth, relativeToAnchor,
} from "./timeline-layout";

/** What happened, in clinical words. The card headline used to be the RULE id,
 *  so two cards on one day both read "FOLLOWUPSCHEDULED" with nothing to say
 *  they were the same visit — a reader could not tell one visit judged twice
 *  from two visits judged once. */
const KIND_LABEL: Record<string, string> = {
  outpatient: "Clinic visit",
  ed: "ED visit",
  asthma_encounters: "Asthma visit",
  ocs_bursts: "Steroid course",
  exacerbations: "Exacerbation",
  obligation_points: "Controller due",
};
const kindLabel = (k: string) => KIND_LABEL[k] ?? k.replace(/_/g, " ");
const ruleLabel = (ruleId: string) => ruleId.replace(/^R-T\d-/, "");

// Local mirrors of @chart-review/platform-types (client convention — see
// AdherenceReview.tsx header note). Exported for AdherenceReview to reuse.
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
     *  defense-in-depth filter (spec 2026-08-24 Task 5 review, Critical 2)
     *  so a reviewer-facing event control is never seeded from an
     *  agent-sourced answer. Optional: legacy/period-only events predate
     *  per-answer provenance. */
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

/** Whether a rule_event is "anchored" (has a specific position on the
 *  timeline) vs a whole-window rule (anchor.type==="window", rendered only
 *  as a chip). A card needs an x-position, which needs a valid date — an
 *  event with anchor.type!=="window" but no date can't be placed and is
 *  excluded from both the timeline cards AND (via this shared predicate)
 *  the reviewer's Events list in AdherenceReview.tsx, so the two surfaces
 *  can't disagree on the anchored count. */
export function isAnchoredEvent(e: Pick<RuleEvent, "anchor">): boolean {
  return e.anchor.type !== "window" && !!e.anchor.date;
}

export interface EventTimelineProps {
  events: RuleEvent[];
  rollups: RuleRollup[];
  validatedEvents: Set<string>;
  mode: "review" | "blind" | "compare";
  compareEvents?: RuleEvent[]; // human side, compare mode only
  /** Agent-draft snapshot for compare mode's "A:" chip (spec 2026-08-24
   *  event-concordance design, Task 6 review Critical 1). `events` is the
   *  ACTIVE session's CANONICAL rule_events, which drifts toward
   *  reviewer-edited values as validation proceeds (the event-verdict route
   *  stamps ev.source="reviewer" + re-derives the verdict on every save) —
   *  showing THAT as "A:" manufactures agreement with the human side that
   *  isn't real. When provided, the "A:" chip's verdict/evaluable is looked
   *  up in THIS array by event_id instead of `events` — pass the frozen
   *  import-time agent draft (state.agent_rule_events[<agent id>]), which no
   *  save route ever touches. Falls back to `events` itself when omitted, so
   *  every non-compare caller (and any compare caller with no shadow
   *  snapshot to fall back on) is byte-identical to before this prop
   *  existed. Card POSITIONS/enumeration are unaffected either way — those
   *  always come from `events`, never from this. */
  agentEvents?: RuleEvent[];
  selectedEventId?: string | null;
  onSelectEvent: (eventId: string) => void;
  /** Reference point for the left gutter's relative offsets ("index", "-28d").
   *  When omitted, the NEWEST occurrence is used and labelled from there — the
   *  offsets stay meaningful as spacing between days of care even without the
   *  patient's index date plumbed through. */
  indexDate?: string;
}

const VERDICT_STYLE: Record<string, string> = {
  CONCORDANT: "bg-[hsl(var(--sage))]/15 text-[hsl(var(--sage))]",
  NON_CONCORDANT: "bg-[hsl(var(--oxblood))]/12 text-[hsl(var(--oxblood))]",
  EXCLUDED: "bg-muted text-muted-foreground",
};
const verdictLabel = (v?: string) =>
  v === "NON_CONCORDANT" ? "NON-CONCORDANT" : v ?? "—";
const verdictAbbrev = (v?: string) =>
  v === "CONCORDANT" ? "C" : v === "NON_CONCORDANT" ? "NC" : v === "EXCLUDED" ? "EXCL" : "—";
// Compare-chip helpers (spec 2026-08-24 review, Important 1 + Task 6
// re-review Important 2): a compare-mode chip must distinguish FOUR states
// that all used to collapse toward the same "—" —
//   "not evaluable"   (evaluable===false; the engine leaves verdict
//                      undefined for these)
//   "not yet scored"  (present, evaluable!==false, but verdict is still
//                      undefined — the COMMON mid-annotation case: a seeded
//                      stub carries neither evaluable nor verdict, and the
//                      blind seed route deliberately computes no verdicts
//                      until the annotator answers it)
//   "genuinely absent" (no event on this side at all)
//   an evaluable, scored event with an actual verdict.
// Collapsing "not evaluable"/"not yet scored" into "genuinely absent" made
// Task 7's IAA score an in-progress or excluded event against a not-observed
// one as a plain disagreement, when none of those three are comparable to a
// real verdict, and not to EACH OTHER either.
function chipAbbrev(e?: RuleEvent): string {
  if (!e) return "—"; // genuinely absent — no event on this side
  if (e.evaluable === false) return "NE";
  if (!e.verdict) return "?"; // present, not yet scored
  return verdictAbbrev(e.verdict);
}
function chipClass(e?: RuleEvent): string {
  if (!e) return "bg-[hsl(var(--ochre))]/20 text-[hsl(var(--ochre))]"; // "not observed"
  if (e.evaluable === false) return VERDICT_STYLE.EXCLUDED; // settled: not evaluable — same muted style review mode uses
  if (!e.verdict) return "text-muted-foreground/70"; // pending: no fill, reads lighter than a settled NE
  return VERDICT_STYLE[e.verdict ?? "EXCLUDED"];
}
function chipTitle(prefix: string, e?: RuleEvent): string {
  if (!e) return `${prefix}: not observed`;
  if (e.evaluable === false) return `${prefix}: not evaluable`;
  if (!e.verdict) return `${prefix}: not yet scored`;
  return `${prefix} ${verdictLabel(e.verdict)}`;
}
export function EventTimeline(props: EventTimelineProps) {
  const { events, rollups, validatedEvents, mode, compareEvents, agentEvents, selectedEventId, onSelectEvent, indexDate } = props;
  const anchored = useMemo(
    () => events
      .filter(isAnchoredEvent)
      .sort((a, b) => (b.anchor.date ?? "").localeCompare(a.anchor.date ?? "")),
    [events],
  );
  const windowEvents = useMemo(() => events.filter((e) => e.anchor.type === "window"), [events]);
  const win = useMemo(() => deriveWindow(anchored), [anchored]);
  // One entry per DAY OF CARE, not per rule — see groupByOccurrence.
  const occurrences = useMemo(() => groupByOccurrence(anchored), [anchored]);
  const monthGroups = useMemo(() => groupOccurrencesByMonth(occurrences), [occurrences]);
  const anchorDate = indexDate ?? occurrences[0]?.date;

  const humanById = useMemo(() => new Map((compareEvents ?? []).map((e) => [e.event_id, e])), [compareEvents]);
  // Falls back to `events` when no agentEvents snapshot is supplied — see
  // the prop's doc comment. Byte-identical A: data to before this prop
  // existed for every caller that doesn't pass it.
  const agentById = useMemo(
    () => new Map((agentEvents ?? events).map((e) => [e.event_id, e])),
    [agentEvents, events],
  );
  // ANCHORED-only (Task 6 re-review, Important 3) — must stay in lockstep
  // with AdherenceReview's compareSummary, which counts `human only` over
  // anchored events exclusively (window-rule stubs are reported separately,
  // never as comparable cards). Before this fix, a compare-side window (or
  // dateless) event absent from the active side was NAMED here but not
  // counted in the summary's `human only: N` — exactly the discrepancy a
  // reviewer consults this strip to resolve.
  const humanOnly = useMemo(() => {
    const activeAnchoredIds = new Set(events.filter(isAnchoredEvent).map((e) => e.event_id));
    return (compareEvents ?? []).filter((h) => isAnchoredEvent(h) && !activeAnchoredIds.has(h.event_id));
  }, [compareEvents, events]);
  const showVerdicts = mode !== "blind";
  const totals = useMemo(() => {
    let c = 0, n = 0;
    for (const r of rollups) { c += r.n_concordant; n += r.n_evaluable; }
    return { c, n };
  }, [rollups]);

  return (
    <div className="border border-border rounded-md bg-card">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border text-[12px]">
        <span className="uppercase tracking-wider text-muted-foreground">Adherence timeline · {win.start} → {win.end}</span>
        {showVerdicts && (
          <span>
            {mode === "compare" ? "Agent composite" : "Composite"}: <b>{totals.c}/{totals.n} concordant{totals.n > 0 ? ` (${Math.round((totals.c / totals.n) * 100)}%)` : ""}</b>
          </span>
        )}
      </div>

      <div className="max-h-[420px] overflow-y-auto">
        {monthGroups.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-muted-foreground">
            No dated events in the observation window.
          </div>
        )}
        {monthGroups.map((g) => (
          <div key={g.key}>
            <div className="sticky top-0 z-10 bg-muted/70 backdrop-blur-sm px-3 py-1 border-y border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
              {g.label}
            </div>
            {g.occurrences.map((occ) => (
              <div key={occ.key} className="flex gap-2 px-3 py-1.5 border-b border-border/40">
                {/* Gutter: the date, and how far it sits from the reference
                    point — spacing between days of care is the thing a reader
                    scans for, and it is invisible in a bare date column. */}
                <div className="w-[82px] shrink-0 text-right leading-tight">
                  <div className="text-[10.5px] tabular-nums">{occ.date}</div>
                  {(() => {
                    const rel = relativeToAnchor(occ.date, anchorDate);
                    return rel ? <div className="text-[9.5px] text-muted-foreground">{rel}</div> : null;
                  })()}
                </div>
                {/* Rail */}
                <div className="relative w-3 shrink-0 flex justify-center" aria-hidden="true">
                  <span className="absolute inset-y-0 w-px bg-border" />
                  <span className="relative mt-[4px] w-2 h-2 rounded-full bg-[hsl(var(--oxblood))]" />
                </div>
                <div className="min-w-0 flex-1">
                  {/* What happened that day — not a rule id. Several kinds can
                      share a day (an ED visit and the steroid course started
                      at it), so every kind present is named. */}
                  <div className="flex flex-wrap items-center gap-1">
                    {occ.kinds.map((k) => (
                      <span key={k} className="rounded bg-muted px-1 py-px text-[9.5px] uppercase tracking-wider text-muted-foreground">
                        {kindLabel(k)}
                      </span>
                    ))}
                    {occ.events.length > 1 && (
                      <span className="text-[9.5px] text-muted-foreground">· {occ.events.length} rules judged</span>
                    )}
                  </div>
                  <div className="mt-0.5">
                    {occ.events.map((e) => {
                      const human = humanById.get(e.event_id);
                      const agentSide = agentById.get(e.event_id);
                      const notEvaluable = e.evaluable === false;
                      return (
                        <button
                          key={e.event_id}
                          type="button"
                          onClick={() => onSelectEvent(e.event_id)}
                          aria-current={selectedEventId === e.event_id}
                          title={e.event_id}
                          className={cn(
                            "w-full text-left flex items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/50",
                            selectedEventId === e.event_id && "bg-muted ring-1 ring-[hsl(var(--oxblood))]",
                          )}
                        >
                          <span className="flex-1 truncate">{ruleLabel(e.rule_id)}</span>
                          {mode !== "blind" && validatedEvents.has(e.event_id) && (
                            <span className="shrink-0 text-[9px] uppercase text-[hsl(var(--sage))]">validated</span>
                          )}
                          {showVerdicts && mode === "review" && (
                            <span className={cn(
                              "shrink-0 rounded px-1 text-[10px]",
                              VERDICT_STYLE[notEvaluable ? "EXCLUDED" : (e.verdict ?? "EXCLUDED")],
                            )}>
                              {notEvaluable ? "NOT EVALUABLE" : verdictLabel(e.verdict)}
                            </span>
                          )}
                          {mode === "compare" && (
                            <span className="shrink-0 flex gap-1">
                              <span className={cn("rounded px-1", chipClass(agentSide))} title={chipTitle("agent", agentSide)}>
                                A: {chipAbbrev(agentSide)}
                              </span>
                              <span className={cn("rounded px-1", chipClass(human))} title={chipTitle("human", human)}>
                                H: {chipAbbrev(human)}
                              </span>
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {mode === "compare" && humanOnly.length > 0 && (
        <div className="px-3 py-1 text-[11px] text-[hsl(var(--ochre))]">
          human only: {humanOnly.map((h) => h.event_id).join(", ")}
        </div>
      )}

      {/* KNOWN GAP (Task 6 re-review #5): this strip's dot/verdict always
       *  reads `e.verdict` off `events` — the ACTIVE session's canonical
       *  array — even in compare mode. That's the SAME provenance ambiguity
       *  Critical 1 fixed for anchored-event "A:" chips (a reviewer-edited
       *  canonical value rendering as if it were untouched agent output),
       *  just not yet extended to window rules — which is where MOST rules
       *  actually live (8 of 11 on asthma). Not fixed here: window rules
       *  aren't compared at all yet (no A/H chips, no agentEvents lookup),
       *  which is Issue 1's other half — a design question for the
       *  dataviz/UX pass, not this task. Filed for that pass. */}
      <div className="border-t border-dashed border-border px-3 py-2">
        <div className="uppercase tracking-wider text-[10px] text-muted-foreground mb-1">Window rules (whole observation window)</div>
        <div className="flex flex-wrap gap-1">
          {windowEvents.map((e) => {
            const roll = rollups.find((r) => r.rule_id === e.rule_id);
            return (
              <button
                key={e.event_id}
                type="button"
                onClick={() => onSelectEvent(e.event_id)}
                aria-current={selectedEventId === e.event_id}
                title={showVerdicts ? verdictLabel(e.verdict) : undefined}
                className={cn("border border-border rounded-full px-2 py-0.5 text-[10px] flex items-center gap-1",
                  selectedEventId === e.event_id && "ring-2 ring-[hsl(var(--oxblood))]")}
              >
                {showVerdicts && (
                  <>
                    <span className={cn("w-2 h-2 rounded-full inline-block",
                      e.verdict === "CONCORDANT" ? "bg-[hsl(var(--sage))]" : e.verdict === "NON_CONCORDANT" ? "bg-[hsl(var(--oxblood))]" : "bg-muted-foreground")} />
                    <span className="sr-only">{verdictLabel(e.verdict)}</span>
                  </>
                )}
                <span>{e.rule_id.replace(/^R-T\d-/, "")}</span>
                {showVerdicts && roll && <span className="text-muted-foreground">· {roll.n_concordant}/{roll.n_evaluable}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
