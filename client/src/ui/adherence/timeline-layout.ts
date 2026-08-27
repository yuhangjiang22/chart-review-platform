// Pure layout math for the adherence event timeline.
// No DOM, no React — unit-testable in isolation. All labels English.
//
// The timeline is a VERTICAL chronological list, newest first, grouped by
// month — the same shape as the source-data Timeline tab (client/src/
// TimelineTab.tsx), which the study lead picked over the earlier horizontal
// axis. The horizontal version placed cards absolutely in lanes above and
// below an axis; with variable-height cards they overran their lanes and
// covered the axis, and the collision math grew with every rule added. A
// vertical list cannot occlude anything and takes any number of events.
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

/** Observation window, shown in the header so a reader knows the period the
 *  rates are over.
 *
 *  min..max anchored event dates padded 14 days, then widened to at least
 *  MIN_SPAN_DAYS. The floor matters: two events a day apart used to report a
 *  30-day window, which read as "the observation period was one month" and
 *  made the sparsest charts look the busiest.
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
  // date, so padding the future would show time the patient could not have
  // been observed in.
  if (end - start < MIN_SPAN_DAYS * DAY) start = end - MIN_SPAN_DAYS * DAY;
  return { start: iso(start), end: iso(end) };
}

/** One thing that happened to the patient on one day — a clinic visit, an ED
 *  visit, a steroid course, the day a controller became due. Several RULES can
 *  be judged at one occurrence, so an occurrence carries a list of events.
 *
 *  The timeline used to draw one row per EVENT, which meant one visit appeared
 *  two or three times (once per rule anchored on it) with nothing to say they
 *  were the same visit. Grouping by day is the same
 *  one-visit-day-is-one-decision-point rule the anchor derivation applies. */
export interface Occurrence {
  key: string;
  date: string;
  /** Distinct anchor kinds present that day, sorted — drives the row headline. */
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

/** Group anchored events into per-day occurrences, NEWEST FIRST (matching the
 *  source Timeline tab). Undated and window events are dropped — they have no
 *  place on a chronology. */
export function groupByOccurrence(events: TimelineEventLite[]): Occurrence[] {
  const byDate = new Map<string, TimelineEventLite[]>();
  for (const e of events) {
    if (e.anchor.type === "window" || !validDate(e.anchor.date)) continue;
    const d = e.anchor.date.slice(0, 10);
    (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(e);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, evs]) => ({
      key: date,
      date,
      kinds: [...new Set(evs.map(anchorKindOf))].sort(),
      events: [...evs].sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
    }));
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/** "2021-09" → "SEPTEMBER 2021". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const idx = Number(m) - 1;
  return `${(MONTHS[idx] ?? m).toUpperCase()} ${y}`;
}

export interface MonthGroup { key: string; label: string; occurrences: Occurrence[] }

/** Bucket occurrences into month groups, preserving the newest-first order
 *  groupByOccurrence produced. */
export function groupOccurrencesByMonth(occurrences: Occurrence[]): MonthGroup[] {
  const out: MonthGroup[] = [];
  for (const occ of occurrences) {
    const key = occ.date.slice(0, 7);
    const last = out[out.length - 1];
    if (last?.key === key) last.occurrences.push(occ);
    else out.push({ key, label: monthLabel(key), occurrences: [occ] });
  }
  return out;
}

/** How far a date sits from the reference point, for the left gutter: "index"
 *  / "-28d" / "-2mo". Mirrors the source Timeline tab's format so the two
 *  chronologies read the same way. Null when either date is unusable. */
export function relativeToAnchor(date: string | undefined, anchorDate: string | undefined): string | null {
  if (!validDate(date) || !validDate(anchorDate)) return null;
  const days = Math.round((new Date(date).getTime() - new Date(anchorDate).getTime()) / DAY);
  if (days === 0) return "index";
  if (Math.abs(days) < 30) return `${days > 0 ? "+" : ""}${days}d`;
  return `${days > 0 ? "+" : ""}${Math.round(days / 30)}mo`;
}
