// EventTimeline — single-axis event stream (approved mockup B-v2).
// Presentational only: no fetching, no review-state writes. Three modes:
//   review  — verdict-colored cards + window-rule chips + composite header
//   blind   — same geometry, NO verdicts/rates anywhere (gold collection)
//   compare — per-event agent-vs-human verdict chip pairs + enumeration flags
// ALL user-facing text is English (multi-site team; spec decision 7).
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  deriveWindow, datePercent, monthTicks, clinicalAnchors, assignLanes,
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
const ANCHOR_GLYPH: Record<string, string> = { encounter: "●", ed: "▲", burst: "◆" };
const CARD_HALF_PCT = 6;
const LANE_PX = 64;

export function EventTimeline(props: EventTimelineProps) {
  const { events, rollups, validatedEvents, mode, compareEvents, selectedEventId, onSelectEvent } = props;
  const anchored = useMemo(() => events.filter((e) => e.anchor.type !== "window" && e.anchor.date), [events]);
  const windowEvents = useMemo(() => events.filter((e) => e.anchor.type === "window"), [events]);
  const win = useMemo(() => deriveWindow(anchored), [anchored]);
  const ticks = useMemo(() => monthTicks(win), [win]);
  const anchors = useMemo(() => clinicalAnchors(anchored), [anchored]);
  const lanes = useMemo(() => assignLanes(anchored, win, CARD_HALF_PCT), [anchored, win]);
  const humanById = useMemo(() => new Map((compareEvents ?? []).map((e) => [e.event_id, e])), [compareEvents]);
  const humanOnly = useMemo(
    () => (compareEvents ?? []).filter((h) => !events.some((e) => e.event_id === h.event_id)),
    [compareEvents, events],
  );
  const showVerdicts = mode !== "blind";
  const maxLane = { above: 0, below: 0 };
  for (const l of lanes.values()) maxLane[l.side] = Math.max(maxLane[l.side], l.lane);
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
            Composite: <b>{totals.c}/{totals.n} concordant{totals.n > 0 ? ` (${Math.round((totals.c / totals.n) * 100)}%)` : ""}</b>
          </span>
        )}
      </div>

      <div className="relative px-4 overflow-x-auto">
        <div
          className="relative min-w-[640px]"
          style={{ height: (maxLane.above + 1) * LANE_PX + (maxLane.below + 1) * LANE_PX + 56 }}
        >
          {/* axis */}
          <div className="absolute left-0 right-0 border-t-2 border-border" style={{ top: (maxLane.above + 1) * LANE_PX + 20 }} />
          {ticks.map((t, i) => (
            <span key={i} className="absolute text-[9px] text-muted-foreground" style={{ left: `${t.percent}%`, top: (maxLane.above + 1) * LANE_PX + 24 }}>{t.label}</span>
          ))}
          {anchors.map((a, i) => (
            <span key={i} title={`${a.date}${a.ref ? ` (${a.ref})` : ""}`} className="absolute text-[11px]" style={{ left: `${datePercent(a.date, win)}%`, top: (maxLane.above + 1) * LANE_PX + 8 }}>
              {ANCHOR_GLYPH[a.kind]}
            </span>
          ))}
          {/* event cards */}
          {anchored.map((e) => {
            const pos = lanes.get(e.event_id);
            if (!pos) return null;
            const top = pos.side === "above"
              ? (maxLane.above - pos.lane) * LANE_PX
              : (maxLane.above + 1) * LANE_PX + 40 + pos.lane * LANE_PX;
            const human = humanById.get(e.event_id);
            return (
              <button
                key={e.event_id}
                type="button"
                onClick={() => onSelectEvent(e.event_id)}
                className={cn(
                  "absolute w-[150px] -translate-x-1/2 text-left border rounded-md px-2 py-1 text-[10px] leading-snug bg-card hover:border-foreground/40",
                  selectedEventId === e.event_id ? "ring-2 ring-[hsl(var(--oxblood))]" : "border-border",
                )}
                style={{ left: `${pos.percent}%`, top }}
              >
                <div className="font-mono text-[9px] truncate text-muted-foreground">{e.event_id}</div>
                <div className="uppercase tracking-wider text-[9px]">{e.rule_id.replace(/^R-T\d-/, "")}</div>
                {showVerdicts && mode === "review" && (
                  <span className={cn("inline-block rounded px-1", VERDICT_STYLE[e.verdict ?? "EXCLUDED"])}>
                    {e.evaluable === false ? "NOT EVALUABLE" : verdictLabel(e.verdict)}
                  </span>
                )}
                {mode === "compare" && (
                  <div className="flex gap-1">
                    <span className={cn("rounded px-1", VERDICT_STYLE[e.verdict ?? "EXCLUDED"])}>agent {verdictLabel(e.verdict)}</span>
                    <span className={cn("rounded px-1", human ? VERDICT_STYLE[human.verdict ?? "EXCLUDED"] : "bg-[hsl(var(--ochre))]/20 text-[hsl(var(--ochre))]")}>
                      {human ? `human ${verdictLabel(human.verdict)}` : "agent only"}
                    </span>
                  </div>
                )}
                {validatedEvents.has(e.event_id) && (
                  <span className="text-[9px] text-[hsl(var(--sage))] uppercase">validated</span>
                )}
              </button>
            );
          })}
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
                className={cn("border border-border rounded-full px-2 py-0.5 text-[10px] flex items-center gap-1",
                  selectedEventId === e.event_id && "ring-2 ring-[hsl(var(--oxblood))]")}
              >
                {showVerdicts && (
                  <span className={cn("w-2 h-2 rounded-full inline-block",
                    e.verdict === "CONCORDANT" ? "bg-[hsl(var(--sage))]" : e.verdict === "NON_CONCORDANT" ? "bg-[hsl(var(--oxblood))]" : "bg-muted-foreground")} />
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
