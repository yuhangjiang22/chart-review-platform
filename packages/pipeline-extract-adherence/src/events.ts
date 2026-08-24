// Event work-list expansion (spec 2026-08-24): rules × ETL anchor lists →
// RuleEvent stubs the agent fills via set_event_answer. Deterministic —
// the denominator must be reproducible across runs, models, and sites.
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
 *  - duplicate event_ids (e.g. a rule anchored on two lists where one is a
 *    slice of the other) are deduped first-wins across the whole rule —
 *    set_event_answer upserts by event_id, so a duplicate would silently
 *    double-count the denominator.
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
        if (seen.has(event_id)) continue;
        seen.add(event_id);
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
