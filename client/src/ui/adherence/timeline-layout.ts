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

/** Observation window for the axis.
 *
 *  min..max anchored event dates padded 14 days, then widened to at least
 *  MIN_SPAN_DAYS. The floor matters: a patient with two events a day apart used
 *  to get a 30-day axis, which read as "the observation period was one month"
 *  and made the sparsest charts look the busiest. Holding the axis at a year
 *  keeps two events in a year LOOKING like two events in a year.
 *
 *  No dated events → the 365 days ending today (stable enough for empty states). */
const MIN_SPAN_DAYS = 365;

export function deriveWindow(events: TimelineEventLite[]): TimelineWindow {
  const ts = events.map((e) => e.anchor.date).filter(validDate).map((d) => new Date(d).getTime());
  if (ts.length === 0) {
    const end = Date.now();
    return { start: iso(end - MIN_SPAN_DAYS * DAY), end: iso(end) };
  }
  let start = Math.min(...ts) - 14 * DAY;
  const end = Math.max(...ts) + 14 * DAY;
  // Extend BACKWARD, not forward: the newest event sits at or near the index
  // date, so padding the future would show empty space the patient could not
  // have been observed in.
  if (end - start < MIN_SPAN_DAYS * DAY) start = end - MIN_SPAN_DAYS * DAY;
  return { start: iso(start), end: iso(end) };
}

/** One thing that happened to the patient on one day — a clinic visit, an ED
 *  visit, a steroid course, the day a controller became due. Several RULES can
 *  be judged at one occurrence, so an occurrence carries a list of events.
 *
 *  The timeline used to draw one card per EVENT, which meant one visit appeared
 *  two or three times (once per rule anchored on it) with nothing on the cards
 *  to say they were the same visit. Grouping by day is the same
 *  one-visit-day-is-one-decision-point rule the anchor derivation applies. */
export interface Occurrence {
  key: string;
  date: string;
  /** Distinct anchor kinds present that day, sorted — drives the card headline. */
  kinds: string[];
  events: TimelineEventLite[];
}

/** Kind of an anchored event, for the headline: the ED/outpatient split lives in
 *  anchor.meta.kind, everything else is the anchor list name. */
export function anchorKindOf(e: TimelineEventLite): string {
  const metaKind = e.anchor.meta?.kind;
  if (e.anchor.type === "asthma_encounters" && typeof metaKind === "string") return metaKind;
  return e.anchor.type;
}

/** Group anchored events into per-day occurrences, date-ascending. Undated and
 *  window events are dropped — they have no position on an axis. */
export function groupByOccurrence(events: TimelineEventLite[]): Occurrence[] {
  const byDate = new Map<string, TimelineEventLite[]>();
  for (const e of events) {
    if (e.anchor.type === "window" || !validDate(e.anchor.date)) continue;
    const d = e.anchor.date.slice(0, 10);
    (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(e);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, evs]) => ({
      key: date,
      date,
      kinds: [...new Set(evs.map(anchorKindOf))].sort(),
      events: [...evs].sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
    }));
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
  occurrences: Occurrence[],
  w: TimelineWindow,
  cardHalfWidthPct: number,
): Map<string, LanePos> {
  const out = new Map<string, LanePos>();
  // Alternate sides by chronological position rather than by rule: an
  // occurrence carries several rules, so there is no single rule to key a side
  // off, and alternating in time is what keeps neighbours apart anyway.
  const occupied: Record<"above" | "below", Array<Array<[number, number]>>> = { above: [], below: [] };
  const dated = [...occurrences].sort((a, b) => a.date.localeCompare(b.date));
  dated.forEach((occ, i) => {
    const side: "above" | "below" = i % 2 === 0 ? "above" : "below";
    const p = datePercent(occ.date, w);
    const span: [number, number] = [p - cardHalfWidthPct, p + cardHalfWidthPct];
    let lane = 0;
    for (;;) {
      const row = (occupied[side][lane] ??= []);
      if (row.every(([s, en]) => span[1] < s || span[0] > en)) { row.push(span); break; }
      lane++;
    }
    out.set(occ.key, { side, lane, percent: p });
  });
  return out;
}
