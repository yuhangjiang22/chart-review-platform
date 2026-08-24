// Renders the EVENT WORK-LIST section of the adherence batch prompt.
// Only anchored (non-window) events appear: window rules are answered
// through the normal patient-level set_question_answer flow and rolled
// up automatically. Empty string when the task has no anchored events,
// so legacy adherence prompts stay byte-identical.
import type { RuleEvent } from "@chart-review/platform-types";
import { WINDOW_ANCHOR_TYPE } from "@chart-review/rule-engine";

export function buildEventWorklistBlock(worklist: RuleEvent[]): string {
  const anchored = worklist.filter((e) => e.anchor.type !== WINDOW_ANCHOR_TYPE);
  if (anchored.length === 0) return "";
  const lines: string[] = [
    "",
    "EVENT WORK-LIST — this task also evaluates PER-EVENT rules. Each line",
    "below is one event you MUST commit exactly once via `set_event_answer`",
    "({event_id, answers:[{question_id, answer, evidence, ...}]}). Answer the",
    "event's questions AS OF THAT DATE (control level at that visit, regimen",
    "at that visit, follow-up scheduled after that event). If an anchor is",
    "not judgeable for its rule, commit it with evaluable:false and an",
    "evaluable_reason instead of guessing. If the notes document an event",
    "the list missed, add it with new_event {rule_id, anchor_type, date,",
    "note_id} — its note origin is recorded.",
    "",
  ];
  for (const e of anchored) {
    const ref = e.anchor.ref ? ` (${e.anchor.ref})` : "";
    const meta = e.anchor.meta && Object.keys(e.anchor.meta).length > 0
      ? ` [${Object.entries(e.anchor.meta).map(([k, v]) => `${k}=${v}`).join(", ")}]`
      : "";
    lines.push(`  - ${e.event_id} — rule ${e.rule_id}, ${e.anchor.type} on ${e.anchor.date}${ref}${meta}`);
  }
  lines.push("");
  return lines.join("\n");
}
