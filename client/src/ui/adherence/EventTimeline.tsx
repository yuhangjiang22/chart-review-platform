// EventTimeline — single-axis event stream (approved mockup B-v2).
// Presentational only: no fetching, no review-state writes. Three modes:
//   review  — verdict-colored cards + window-rule chips + composite header
//   blind   — same geometry, NO verdicts/rates anywhere (gold collection)
//   compare — per-event agent-vs-human verdict chip pairs + enumeration flags
// ALL user-facing text is English (multi-site team; spec decision 7).
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  deriveWindow, datePercent, monthTicks, clinicalAnchors, assignLanes, cardHalfPct,
} from "./timeline-layout";

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
const ANCHOR_GLYPH: Record<string, string> = { encounter: "●", ed: "▲", burst: "◆" };
// px — must match the card button's rendered width (Tailwind w-[150px] below).
const CARD_W = 150;
const LANE_PX = 64;

export function EventTimeline(props: EventTimelineProps) {
  const { events, rollups, validatedEvents, mode, compareEvents, agentEvents, selectedEventId, onSelectEvent } = props;
  const anchored = useMemo(
    () => events
      .filter(isAnchoredEvent)
      .sort((a, b) => (a.anchor.date ?? "").localeCompare(b.anchor.date ?? "")),
    [events],
  );
  const windowEvents = useMemo(() => events.filter((e) => e.anchor.type === "window"), [events]);
  const win = useMemo(() => deriveWindow(anchored), [anchored]);
  const ticks = useMemo(() => monthTicks(win), [win]);
  const anchors = useMemo(() => clinicalAnchors(anchored), [anchored]);

  // The lane-collision half-width must always equal half the card's
  // RENDERED width, expressed as a percent of the track — hardcoding a
  // fixed percent decouples the collision test from the real card and lets
  // cards overlap at narrow widths (see cardHalfPct's doc comment in
  // timeline-layout.ts). We measure the track and derive the percent live.
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(0);
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    // Seed synchronously from the current layout (before paint) so the
    // first frame already uses the real width instead of the fallback —
    // avoids a visible re-pack flash once ResizeObserver's first callback
    // would otherwise fire.
    setTrackW(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") {
      // jsdom (tests) / very old browsers have no ResizeObserver — fall
      // back to a representative desktop track width so lane packing still
      // runs deterministically.
      setTrackW(1250);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      // Guard the read: a missing entry can't throw, and rounding avoids
      // re-render churn on every sub-pixel drag during a live resize.
      const w = entries[0]?.contentRect.width;
      if (w != null) setTrackW(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const halfPct = cardHalfPct(trackW, CARD_W);
  const lanes = useMemo(() => assignLanes(anchored, win, halfPct), [anchored, win, halfPct]);

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
  const maxLane = { above: 0, below: 0 };
  for (const l of lanes.values()) maxLane[l.side] = Math.max(maxLane[l.side], l.lane);
  const axisTop = (maxLane.above + 1) * LANE_PX;
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

      <div className="relative px-4 overflow-x-auto">
        <div
          className="relative min-w-[640px]"
          style={{ height: axisTop + 56 + (maxLane.below + 1) * LANE_PX + 8 }}
        >
          {/* Inset track: 0%..100% maps to THIS div, inset by half a card
              width on each side, so a card centered at 0% or 100% stays
              fully inside the container instead of being clipped. */}
          <div
            ref={trackRef}
            className="absolute inset-0"
            style={{ marginLeft: CARD_W / 2, marginRight: CARD_W / 2 }}
          >
            {/* axis */}
            <div className="absolute left-0 right-0 border-t-2 border-border" style={{ top: axisTop + 20 }} />
            {/* Ticks stay left-aligned (not centered like glyphs/cards) — a
                tick marks a month BOUNDARY, a single point in time, not a
                range with a visual width to center against. */}
            {ticks.map((t) => (
              <span key={t.date} className="absolute text-[9px] text-muted-foreground" style={{ left: `${t.percent}%`, top: axisTop + 24 }}>{t.label}</span>
            ))}
            {anchors.map((a) => (
              <span
                key={`${a.date}|${a.ref ?? ""}|${a.kind}`}
                title={`${a.date}${a.ref ? ` (${a.ref})` : ""}`}
                aria-hidden="true"
                className="absolute text-[11px] -translate-x-1/2"
                style={{ left: `${datePercent(a.date, win)}%`, top: axisTop + 8 }}
              >
                {ANCHOR_GLYPH[a.kind]}
              </span>
            ))}
            {/* event cards */}
            {anchored.map((e) => {
              const pos = lanes.get(e.event_id);
              if (!pos) return null;
              const top = pos.side === "above"
                ? (maxLane.above - pos.lane) * LANE_PX
                : axisTop + 56 + pos.lane * LANE_PX;
              const human = humanById.get(e.event_id);
              const notEvaluable = e.evaluable === false;
              return (
                <button
                  key={e.event_id}
                  type="button"
                  onClick={() => onSelectEvent(e.event_id)}
                  aria-current={selectedEventId === e.event_id}
                  className={cn(
                    "absolute w-[150px] -translate-x-1/2 text-left border rounded-md px-2 py-1 text-[10px] leading-snug bg-card hover:border-foreground/40",
                    selectedEventId === e.event_id ? "ring-2 ring-[hsl(var(--oxblood))]" : "border-border",
                  )}
                  style={{ left: `${pos.percent}%`, top }}
                >
                  <div className="font-mono text-[9px] truncate text-muted-foreground">{e.event_id}</div>
                  <div className="uppercase tracking-wider text-[9px]">{e.rule_id.replace(/^R-T\d-/, "")}</div>
                  {showVerdicts && mode === "review" && (
                    <span className={cn("inline-block rounded px-1", VERDICT_STYLE[notEvaluable ? "EXCLUDED" : (e.verdict ?? "EXCLUDED")])}>
                      {notEvaluable ? "NOT EVALUABLE" : verdictLabel(e.verdict)}
                    </span>
                  )}
                  {mode === "compare" && (() => {
                    const agentSide = agentById.get(e.event_id);
                    return (
                      <div className="flex flex-wrap gap-1">
                        <span
                          className={cn("rounded px-1 whitespace-nowrap", chipClass(agentSide))}
                          title={chipTitle("agent", agentSide)}
                        >
                          A: {chipAbbrev(agentSide)}
                        </span>
                        <span
                          className={cn("rounded px-1 whitespace-nowrap", chipClass(human))}
                          title={chipTitle("human", human)}
                        >
                          H: {chipAbbrev(human)}
                        </span>
                      </div>
                    );
                  })()}
                  {mode !== "blind" && validatedEvents.has(e.event_id) && (
                    <span className="text-[9px] text-[hsl(var(--sage))] uppercase">validated</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
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
