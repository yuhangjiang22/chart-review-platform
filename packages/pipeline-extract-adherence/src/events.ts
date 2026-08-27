// Event work-list expansion (spec 2026-08-24): rules × ETL anchor lists →
// RuleEvent stubs the agent fills via set_event_answer. Deterministic —
// the denominator must be reproducible across runs, models, and sites.
import { createHash } from "node:crypto";
import type { RuleEvent } from "@chart-review/platform-types";
import { windowEventStub, type RuleDefinition } from "@chart-review/rule-engine";

/** One entry of a per-patient anchor list (anchors/<name>.json). */
export interface AnchorEntry {
  /** ISO date of the candidate event. */
  date: string;
  /** OMOP provenance, "table:row_id". */
  ref?: string;
  /** Task-defined extras (encounter kind, burst length, …) — surfaced to
   *  the agent in the work-list, never interpreted by the platform. */
  meta?: Record<string, unknown>;
}

/** Narrow raw JSON rows (readAnchors output) to AnchorEntry[] — keeps only
 *  objects with a string date. Malformed rows are dropped, not guessed at. */
export function toAnchorEntries(rows: unknown[]): AnchorEntry[] {
  return rows.filter(
    (r): r is AnchorEntry => typeof r === "object" && r !== null && typeof (r as { date?: unknown }).date === "string",
  );
}

/** Expand rules over the patient's anchor lists.
 *  - `event_anchor: <name>` / `[<names>]` → one stub per anchor entry.
 *  - no `event_anchor` → one `<rule_id>@window` stub (legacy behavior).
 *  - missing anchor list → zero stubs for that rule (its rollup will be
 *    EXCLUDED unless the agent supplements note-origin events).
 *  - ONE EVENT PER (rule, DATE), first-wins in the order the rule declares its
 *    lists. This is a work-list of POTENTIAL events — the agent and the engine
 *    can still exclude any of them downstream — but a same-day duplicate is the
 *    one defect exclusion cannot repair: two events for one occasion carry the
 *    same question, get the same answer, are both evaluable, and are both
 *    counted. Nothing downstream knows they are one occasion.
 *
 *    Deduping by event_id (which embeds `ref`) was the earlier reading and was
 *    circular: the dedup key WAS the identity, so it only ever collapsed
 *    entries that were already identical. In the real data they are not — an
 *    OCS course written at an asthma ED visit appears as `encounters:<id>` in
 *    asthma_encounters and `drugs:<id>` in ocs_bursts, same date, different ref,
 *    so R-T2-FollowupScheduled asked "was follow-up arranged" twice for that
 *    one day. The existing test missed it because its fixture put the SAME
 *    AnchorEntry object in both lists, the friendliest possible case.
 *
 *    Identity and occasion are different requirements: event_ids must be
 *    unique, and a rule must be judged at most once per date. Only the second
 *    protects the denominator.
 *
 *  Declaration order is therefore load-bearing. R-T2-FollowupScheduled lists
 *  `[asthma_encounters, ocs_bursts]` in that order because the VISIT is where a
 *  follow-up gets arranged; the steroid course on the same day is the same
 *  occasion seen from the pharmacy side.
 *
 *  Anchor-list on-disk order is part of the identity contract: the
 *  `${name}:${i}` fallback id embeds the list index, and downstream rollup
 *  takes the FIRST non-concordant event's attribution. The ETL must emit
 *  entries date-ascending and stable — this function does not sort. */
export function expandEventWorklist(
  rules: RuleDefinition[],
  anchors: Record<string, AnchorEntry[]>,
): RuleEvent[] {
  const out: RuleEvent[] = [];
  for (const rule of rules) {
    if (!rule.event_anchor) {
      out.push(windowEventStub(rule.rule_id));
      continue;
    }
    const seen = new Set<string>();
    const lists = Array.isArray(rule.event_anchor) ? rule.event_anchor : [rule.event_anchor];
    for (const name of lists) {
      for (const [i, a] of (anchors[name] ?? []).entries()) {
        const event_id = `${rule.rule_id}@${a.date}@${a.ref ?? `${name}:${i}`}`;
        // A dateless entry has no occasion to collide on, so it falls back to
        // identity — otherwise every dateless entry in a rule would collapse
        // into one.
        const occasion = a.date ? `${rule.rule_id}@${a.date}` : event_id;
        if (seen.has(occasion)) continue;
        seen.add(occasion);
        out.push({
          event_id,
          rule_id: rule.rule_id,
          anchor: { type: name, date: a.date, origin: "omop", ref: a.ref, meta: a.meta },
        });
      }
    }
  }
  return out;
}

/** Stable hash of a work-list's sorted event_ids — the cheap "did the two
 *  seeds land on the same denominator" signal stamped into
 *  RuleEventsProvenance.worklist_hash by both seed sites (the agent
 *  runner and the blind-annotation seed-events route). Sorted so seed
 *  order (which `expandEventWorklist` deliberately does NOT normalize)
 *  doesn't produce spurious hash drift between two runs over an
 *  identical set of events. */
export function computeWorklistHash(events: Pick<RuleEvent, "event_id">[]): string {
  const ids = events.map((e) => e.event_id).sort();
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}
