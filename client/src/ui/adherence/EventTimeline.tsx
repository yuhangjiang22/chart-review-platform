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
  answers?: Array<{ question_id: string; tier: number; answer: string | number | boolean | null }>;
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
const ANCHOR_GLYPH: Record<string, string> = { encounter: "●", ed: "▲", burst: "◆" };
// px — must match the card button's rendered width (Tailwind w-[150px] below).
const CARD_W = 150;
const LANE_PX = 64;

export function EventTimeline(props: EventTimelineProps) {
  const { events, rollups, validatedEvents, mode, compareEvents, selectedEventId, onSelectEvent } = props;
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
  const humanOnly = useMemo(
    () => (compareEvents ?? []).filter((h) => !events.some((e) => e.event_id === h.event_id)),
    [compareEvents, events],
  );
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
                  {mode === "compare" && (
                    <div className="flex flex-wrap gap-1">
                      <span
                        className={cn("rounded px-1 whitespace-nowrap", VERDICT_STYLE[e.verdict ?? "EXCLUDED"])}
                        title={`agent ${verdictLabel(e.verdict)}`}
                      >
                        A: {verdictAbbrev(e.verdict)}
                      </span>
                      <span
                        className={cn("rounded px-1 whitespace-nowrap", human ? VERDICT_STYLE[human.verdict ?? "EXCLUDED"] : "bg-[hsl(var(--ochre))]/20 text-[hsl(var(--ochre))]")}
                        title={human ? `human ${verdictLabel(human.verdict)}` : "human: not observed"}
                      >
                        H: {human ? verdictAbbrev(human.verdict) : "—"}
                      </span>
                    </div>
                  )}
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
