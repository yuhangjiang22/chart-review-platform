// Pure layout math for the adherence event timeline (mockup B-v2).
// No DOM, no React — unit-testable in isolation. All labels English.
export interface TimelineEventLite {
  event_id: string;
  rule_id: string;
  anchor: { type: string; date?: string; end_date?: string; origin: string; ref?: string; meta?: Record<string, unknown> };
}

export interface TimelineWindow { start: string; end: string }

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const validDate = (d?: string): d is string => !!d && ISO_DATE.test(d) && !Number.isNaN(new Date(d).getTime());

/** Observation window = min..max anchored event dates padded 14 days each side.
 *  No dated events → the 365 days ending today (stable enough for empty states). */
export function deriveWindow(events: TimelineEventLite[]): TimelineWindow {
  const ts = events.map((e) => e.anchor.date).filter(validDate).map((d) => new Date(d).getTime());
  if (ts.length === 0) {
    const end = Date.now();
    return { start: iso(end - 365 * DAY), end: iso(end) };
  }
  return { start: iso(Math.min(...ts) - 14 * DAY), end: iso(Math.max(...ts) + 14 * DAY) };
}

/** 0..100 position of a date in the window, clamped. */
export function datePercent(date: string, w: TimelineWindow): number {
  if (!validDate(date)) return 0;
  const s = new Date(w.start).getTime(), e = new Date(w.end).getTime();
  const t = new Date(date).getTime();
  if (e <= s) return 0;
  return Math.min(100, Math.max(0, ((t - s) / (e - s)) * 100));
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** One tick per month boundary inside the window (label = EN month abbr, date = ISO boundary).
 *  If no month boundary falls inside, return window endpoints as fallback ticks. */
export function monthTicks(w: TimelineWindow): Array<{ percent: number; label: string; date: string }> {
  const out: Array<{ percent: number; label: string; date: string }> = [];
  const d = new Date(w.start);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const endTime = new Date(w.end).getTime();
  while (d.getTime() < endTime) {
    const dateStr = iso(d.getTime());
    out.push({ percent: datePercent(dateStr, w), label: MONTHS[d.getUTCMonth()], date: dateStr });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  if (out.length === 0) {
    const startD = new Date(w.start);
    const endD = new Date(w.end);
    out.push({ percent: 0, label: MONTHS[startD.getUTCMonth()], date: w.start });
    out.push({ percent: 100, label: MONTHS[endD.getUTCMonth()], date: w.end });
  }
  return out;
}

/** Clinical anchors for the axis: unique (date, ref, kind) among anchored events.
 *  kind: "burst" for ocs anchors, "ed" when meta.kind === "ed", else "encounter". */
export function clinicalAnchors(events: TimelineEventLite[]): Array<{ date: string; ref?: string; kind: "encounter" | "ed" | "burst" }> {
  const seen = new Map<string, { date: string; ref?: string; kind: "encounter" | "ed" | "burst" }>();
  for (const e of events) {
    const { date, ref, type, meta } = e.anchor;
    if (!validDate(date) || type === "window") continue;
    const kind = type.includes("burst") ? "burst" : (meta as { kind?: string } | undefined)?.kind === "ed" ? "ed" : "encounter";
    const key = `${date}|${ref ?? ""}|${kind}`;
    if (seen.has(key)) continue;
    seen.set(key, { date, ref, kind });
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Half the card width as a PERCENT OF THE TRACK — the invariant assignLanes'
 *  collision test depends on. A hardcoded percent decouples it from the real
 *  card and makes cards overlap at narrow panes (regressed once: 150px cards
 *  at a 700px track need ~10.7%, not 6%). trackW <= 0 (pre-measure / hidden
 *  pane) falls back to the 1250px-track value. */
export function cardHalfPct(trackW: number, cardW: number): number {
  if (!(trackW > 0)) return (cardW / 1250) * 50;
  return (cardW / trackW) * 50;
}

export interface LanePos { side: "above" | "below"; lane: number; percent: number }

/** Card placement: rules are assigned above/below deterministically by
 *  sorting unique rule_ids alphabetically (stable regardless of input order).
 *  Cards on one side whose horizontal extent (percent ± cardHalfWidthPct)
 *  overlaps get bumped to the next sub-lane. Window events are excluded
 *  (they render as chips). Duplicate event_ids in the producer's input
 *  would collide in the Map; the engine contract is that event_ids are
 *  unique per run. */
export function assignLanes(
  events: TimelineEventLite[],
  w: TimelineWindow,
  cardHalfWidthPct: number,
): Map<string, LanePos> {
  const out = new Map<string, LanePos>();
  const sides = new Map<string, "above" | "below">();
  const uniqueRuleIds = [...new Set(events.map((e) => e.rule_id).filter((rid) => {
    const hasDate = events.some((e) => e.rule_id === rid && validDate(e.anchor.date) && e.anchor.type !== "window");
    return hasDate;
  }))].sort();
  let flip: "above" | "below" = "above";
  for (const rid of uniqueRuleIds) {
    sides.set(rid, flip);
    flip = flip === "above" ? "below" : "above";
  }
  const occupied: Record<"above" | "below", Array<Array<[number, number]>>> = { above: [], below: [] };
  const dated = events
    .filter((e) => validDate(e.anchor.date) && e.anchor.type !== "window")
    .sort((a, b) => a.anchor.date!.localeCompare(b.anchor.date!));
  for (const e of dated) {
    const side = sides.get(e.rule_id)!;
    const p = datePercent(e.anchor.date!, w);
    const span: [number, number] = [p - cardHalfWidthPct, p + cardHalfWidthPct];
    let lane = 0;
    for (;;) {
      const row = (occupied[side][lane] ??= []);
      if (row.every(([s, en]) => span[1] < s || span[0] > en)) { row.push(span); break; }
      lane++;
    }
    out.set(e.event_id, { side, lane, percent: p });
  }
  return out;
}
