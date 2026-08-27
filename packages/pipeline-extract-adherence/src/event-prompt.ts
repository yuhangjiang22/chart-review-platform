// Renders the EVENT WORK-LIST section of the adherence batch prompt.
// Only anchored (non-window) events appear: window rules are answered
// through the normal patient-level set_question_answer flow and rolled
// up automatically. Empty string when the task has no anchored events,
// so legacy adherence prompts stay byte-identical.
import type { RuleEvent } from "@chart-review/platform-types";
import {
  WINDOW_ANCHOR_TYPE, eventScopedQuestionsFor, type RuleDefinition,
} from "@chart-review/rule-engine";

/** Per-event instructions for the agent.
 *
 *  Each line names the question_ids that event needs, derived from its rule's
 *  expressions. Earlier versions listed only the event id, rule, anchor type
 *  and date, leaving the agent to infer which questions belonged to which
 *  event — and on a live fixture run it inferred wrong: it answered one
 *  step-therapy event with the follow-up question, left four follow-up events
 *  with no answer at all, and never committed the control level that decides
 *  whether a step-therapy event is judgeable, so that rule produced zero
 *  verdicts from four events. */
export function buildEventWorklistBlock(
  worklist: RuleEvent[],
  rules: RuleDefinition[] = [],
): string {
  const anchored = worklist.filter((e) => e.anchor.type !== WINDOW_ANCHOR_TYPE);
  if (anchored.length === 0) return "";
  const needsByRule = new Map<string, { verdict: string[]; evaluability: string[] }>();
  for (const r of rules) needsByRule.set(r.rule_id, eventScopedQuestionsFor(r));

  const lines: string[] = [
    "",
    "EVENT WORK-LIST — this task also evaluates PER-EVENT rules. Each line",
    "below is one event you MUST commit exactly once via `set_event_answer`",
    "({event_id, answers:[{question_id, answer, evidence, ...}]}).",
    "",
    "Each line names the questions THAT event needs. Commit exactly those",
    "question_ids for that event — a question belonging to another event's",
    "rule is rejected, and an event missing its `answer:` question is recorded",
    "as unanswered rather than judged, so it contributes nothing.",
    "",
    "Answer them AS OF THAT EVENT'S DATE: the control picture at that visit,",
    "the regimen active on that date, the follow-up arranged at that visit —",
    "not the most recent state in the window.",
    "",
    "`decides:` questions determine whether the requirement applies at that",
    "event. If you genuinely cannot establish one from documentation at or",
    "around that date, commit the event with evaluable:false and an",
    "evaluable_reason instead of guessing.",
    "",
    "If the notes document an event the list missed, add it with new_event",
    "{rule_id, anchor_type, date, note_id} — its note origin is recorded.",
    "",
  ];
  for (const e of anchored) {
    const ref = e.anchor.ref ? ` (${e.anchor.ref})` : "";
    const meta = e.anchor.meta && Object.keys(e.anchor.meta).length > 0
      ? ` [${Object.entries(e.anchor.meta).map(([k, v]) => `${k}=${v}`).join(", ")}]`
      : "";
    lines.push(`  - ${e.event_id} — rule ${e.rule_id}, ${e.anchor.type} on ${e.anchor.date}${ref}${meta}`);
    const needs = needsByRule.get(e.rule_id);
    if (needs && (needs.verdict.length > 0 || needs.evaluability.length > 0)) {
      const parts: string[] = [];
      if (needs.verdict.length > 0) parts.push(`answer: ${needs.verdict.join(", ")}`);
      if (needs.evaluability.length > 0) parts.push(`decides: ${needs.evaluability.join(", ")}`);
      lines.push(`      ${parts.join("  |  ")}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
