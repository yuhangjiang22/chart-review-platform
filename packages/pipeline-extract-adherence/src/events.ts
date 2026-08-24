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

/** Expand rules over the patient's anchor lists.
 *  - `event_anchor: <name>` / `[<names>]` → one stub per anchor entry.
 *  - no `event_anchor` → one `<rule_id>@window` stub (legacy behavior).
 *  - missing anchor list → zero stubs for that rule (its rollup will be
 *    EXCLUDED unless the agent supplements note-origin events). */
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
    const lists = Array.isArray(rule.event_anchor) ? rule.event_anchor : [rule.event_anchor];
    for (const name of lists) {
      for (const [i, a] of (anchors[name] ?? []).entries()) {
        out.push({
          event_id: `${rule.rule_id}@${a.date}@${a.ref ?? `${name}:${i}`}`,
          rule_id: rule.rule_id,
          anchor: { type: name, date: a.date, origin: "omop", ref: a.ref },
        });
      }
    }
  }
  return out;
}
