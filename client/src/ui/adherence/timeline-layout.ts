// Pure layout math for the adherence event timeline (mockup B-v2).
// No DOM, no React — unit-testable in isolation. All labels English.
export interface TimelineEventLite {
  event_id: string;
  rule_id: string;
  anchor: { type: string; date?: string; end_date?: string; origin: string; ref?: string; meta?: Record<string, unknown> };
}

export interface Window { start: string; end: string }

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Observation window = min..max anchored event dates padded 14 days each side.
 *  No dated events → the 365 days ending today (stable enough for empty states). */
export function deriveWindow(events: TimelineEventLite[]): Window {
  const ts = events.map((e) => e.anchor.date).filter(Boolean).map((d) => new Date(d!).getTime());
  if (ts.length === 0) {
    const end = Date.now();
    return { start: iso(end - 365 * DAY), end: iso(end) };
  }
  return { start: iso(Math.min(...ts) - 14 * DAY), end: iso(Math.max(...ts) + 14 * DAY) };
}

/** 0..100 position of a date in the window, clamped. */
export function datePercent(date: string, w: Window): number {
  const s = new Date(w.start).getTime(), e = new Date(w.end).getTime();
  const t = new Date(date).getTime();
  if (e <= s) return 0;
  return Math.min(100, Math.max(0, ((t - s) / (e - s)) * 100));
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** One tick per month boundary inside the window (label = EN month abbr). */
export function monthTicks(w: Window): Array<{ percent: number; label: string }> {
  const out: Array<{ percent: number; label: string }> = [];
  const d = new Date(w.start);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const end = new Date(w.end).getTime();
  while (d.getTime() <= end) {
    out.push({ percent: datePercent(iso(d.getTime()), w), label: MONTHS[d.getUTCMonth()] });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/** Clinical anchors for the axis: unique (date, ref) among anchored events.
 *  kind: "burst" for ocs anchors, "ed" when meta.kind === "ed", else "encounter". */
export function clinicalAnchors(events: TimelineEventLite[]): Array<{ date: string; ref?: string; kind: "encounter" | "ed" | "burst"; percent?: number }> {
  const seen = new Map<string, { date: string; ref?: string; kind: "encounter" | "ed" | "burst" }>();
  for (const e of events) {
    const { date, ref, type, meta } = e.anchor;
    if (!date || type === "window") continue;
    const key = `${date}|${ref ?? ""}`;
    if (seen.has(key)) continue;
    const kind = type.includes("burst") ? "burst" : (meta as { kind?: string } | undefined)?.kind === "ed" ? "ed" : "encounter";
    seen.set(key, { date, ref, kind });
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface LanePos { side: "above" | "below"; lane: number; percent: number }

/** Card placement: rules alternate above/below deterministically by first
 *  appearance order (T2-Step-style rules read best above per the mockup, but
 *  the assignment only needs to be STABLE, not semantic). Cards on one side
 *  whose horizontal extent (percent ± cardHalfWidthPct) overlaps get bumped
 *  to the next sub-lane. Window events are excluded (they render as chips). */
export function assignLanes(
  events: TimelineEventLite[],
  w: Window,
  cardHalfWidthPct: number,
): Map<string, LanePos> {
  const out = new Map<string, LanePos>();
  const sides = new Map<string, "above" | "below">();
  let flip: "above" | "below" = "above";
  for (const e of events) {
    if (!e.anchor.date || e.anchor.type === "window") continue;
    if (!sides.has(e.rule_id)) { sides.set(e.rule_id, flip); flip = flip === "above" ? "below" : "above"; }
  }
  const occupied: Record<"above" | "below", Array<Array<[number, number]>>> = { above: [], below: [] };
  const dated = events
    .filter((e) => e.anchor.date && e.anchor.type !== "window")
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
