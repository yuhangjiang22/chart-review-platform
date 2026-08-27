// Renders the EVENT WORK-LIST section of the adherence batch prompt.
// Only anchored (non-window) events appear: window rules are answered
// through the normal patient-level set_question_answer flow and rolled
// up automatically. Empty string when the task has no anchored events,
// so legacy adherence prompts stay byte-identical.
import type { RuleEvent } from "@chart-review/platform-types";
import {
  WINDOW_ANCHOR_TYPE, eventScopedQuestionsFor, type RuleDefinition,
} from "@chart-review/rule-engine";

/** Lead-in before an event during which documentation can still establish the
 *  state of care AT the event — a medication list from the previous visit is
 *  legitimate evidence of the regimen in force today. */
const NOTE_LEAD_IN_DAYS = 90;

/** Notes whose date falls in an event's evidence span: from NOTE_LEAD_IN_DAYS
 *  before the event through the end of its judgment window (the ETL's deadline
 *  when the anchor carries one, else the rule's declared window, else the event
 *  date itself). */
const MAX_NAMED_NOTES = 10;

/** End of an event's judgment span: the ETL's deadline when the anchor carries
 *  one, else the rule's declared window, else null (the requirement is judged AT
 *  the event date, a point). Same precedence the reviewer's UI uses, so the two
 *  sides never disagree about what span an event covers. */
function judgmentEnd(
  eventDate: string | undefined,
  meta: Record<string, unknown> | undefined,
  windowDays: number | undefined,
): string | null {
  if (typeof meta?.deadline === "string") return meta.deadline.slice(0, 10);
  if (typeof windowDays !== "number" || !eventDate) return null;
  const t = new Date(eventDate).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + windowDays * 86_400_000).toISOString().slice(0, 10);
}

function notesForEvent(
  notes: Array<{ filename: string; date: string }>,
  eventDate: string | undefined,
  windowDays: number | undefined,
  meta: Record<string, unknown> | undefined,
): { span: string; named: string[]; extra: number } | null {
  if (!eventDate) return null;
  const t = new Date(eventDate).getTime();
  if (!Number.isFinite(t)) return null;
  const DAY = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const deadline = typeof meta?.deadline === "string" ? new Date(meta.deadline).getTime() : NaN;
  const end = Number.isFinite(deadline)
    ? deadline
    : t + (typeof windowDays === "number" ? windowDays : 0) * DAY;
  const start = t - NOTE_LEAD_IN_DAYS * DAY;
  const inSpan = notes.filter((n) => {
    const nt = new Date(n.date).getTime();
    return Number.isFinite(nt) && nt >= start && nt <= end;
  });
  // The SPAN is the instruction; the filenames are a convenience. Capped
  // because a busy patient's span can hold dozens of notes that have nothing
  // to do with asthma (one real chart's span was mostly elbow x-rays), and a
  // wall of filenames in every prompt is noise the agent has to read past.
  return {
    span: `${iso(start)} … ${iso(end)}`,
    named: inSpan.slice(0, MAX_NAMED_NOTES).map((n) => n.filename),
    extra: Math.max(0, inSpan.length - MAX_NAMED_NOTES),
  };
}

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
  notes: Array<{ filename: string; date?: string }> = [],
): string {
  const anchored = worklist.filter((e) => e.anchor.type !== WINDOW_ANCHOR_TYPE);
  if (anchored.length === 0) return "";
  const needsByRule = new Map<string, { verdict: string[]; evaluability: string[] }>();
  const windowByRule = new Map<string, number | undefined>();
  for (const r of rules) {
    needsByRule.set(r.rule_id, eventScopedQuestionsFor(r));
    windowByRule.set(r.rule_id, r.event_window_days);
  }
  const datedNotes = notes
    .filter((n): n is { filename: string; date: string } => !!n.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const lines: string[] = [
    "",
    "EVENT WORK-LIST — this task also evaluates PER-EVENT rules. Each line",
    "below is one event you MUST commit exactly once via `set_event_answer`",
    "({event_id, answers:[{question_id, answer, evidence, ...}]}).",
    "",
    "Each line names the questions THAT event needs, in two groups. Commit ALL",
    "of them for that event, in ONE call. Both groups are required — an event",
    "missing EITHER is dropped from the results entirely and contributes",
    "nothing:",
    "",
    "  answer:   the question the verdict is computed from.",
    "  decides:  the question that establishes whether the requirement applies",
    "            at that event. Answering it is not optional — it is what makes",
    "            the event countable at all.",
    "",
    "Read the notes NAMED ON THE EVENT'S OWN LINE. They are the ones dated in",
    "that event's span; the patient's chart also holds notes from years outside",
    "the observation window, and those cannot describe the state of care at this",
    "event whatever they say. If an event names no notes, answer from structured",
    "data or mark it not evaluable — do not reach outside the span.",
    "",
    "EVERY answer needs evidence. Cite what it was determined from, dated at or",
    "around that event: a note quote (VERBATIM — the faithfulness gate rejects a",
    "quote absent from the note) or a structured row",
    "(evidence:[{source:'omop', table, row_id}], no quote needed). Cite the",
    "SMALLEST span that supports the answer, not the whole document. An answer",
    "with no evidence is stored but shown to the reviewer as unevidenced, and",
    "cannot be checked without re-reading the chart.",
    "",
    "Answer AS OF THAT EVENT'S DATE: the control picture at that visit, the",
    "regimen active on that date, the follow-up arranged at that visit — not the",
    "most recent state in the window. The same question can therefore have",
    "DIFFERENT answers at different events for one patient; that is the point of",
    "evaluating per event.",
    "",
    "EXCEPTION — an event whose line carries `judge through <date>` is judged over",
    "the SPAN from its own date THROUGH that date, inclusive, not at its date.",
    "The span is a grace period the guideline allows, and it comes from one of two",
    "places: the controller obligation runs to the patient's next asthma visit",
    "(so a controller first started AT that visit MEETS the obligation, and one",
    "started after it does not), and follow-up scheduling runs 3 months from the",
    "event (so a recheck booked three weeks later counts). Judging either at its",
    "own date scores the clinician who did exactly the right thing, slightly",
    "later, as a care gap.",
    "",
    "Only when the chart genuinely cannot establish a `decides:` question at",
    "that date, commit the event with evaluable:false and an evaluable_reason.",
    "That is a real finding worth recording — not a way to skip the event.",
    "",
    "Do not commit a question that is not on that event's line; it is rejected.",
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
    // The judgment span, spelled out rather than left implicit in `deadline=` /
    // the rule's declared window. An agent handed only a date answered span
    // questions at that date.
    const judgeThrough = judgmentEnd(e.anchor.date, e.anchor.meta, windowByRule.get(e.rule_id));
    const span = judgeThrough ? `, judge through ${judgeThrough}` : "";
    lines.push(`  - ${e.event_id} — rule ${e.rule_id}, ${e.anchor.type} on ${e.anchor.date}${span}${ref}${meta}`);
    const needs = needsByRule.get(e.rule_id);
    if (needs && (needs.verdict.length > 0 || needs.evaluability.length > 0)) {
      const parts: string[] = [];
      if (needs.verdict.length > 0) parts.push(`answer: ${needs.verdict.join(", ")}`);
      if (needs.evaluability.length > 0) parts.push(`decides: ${needs.evaluability.join(", ")}`);
      lines.push(`      ${parts.join("  |  ")}`);
    }
    // The notes covering THIS event's span, named. Without them the agent is
    // handed the patient's whole chart with nothing to say which part belongs
    // to which event — on a real patient half the notes predate the
    // observation window entirely, and an answer about a 2021 visit came back
    // cited to a 2018 discharge summary, which every automated check passed
    // because the quote really was in that note.
    const ns = notesForEvent(datedNotes, e.anchor.date, windowByRule.get(e.rule_id), e.anchor.meta);
    if (ns) {
      lines.push(
        ns.named.length > 0
          ? `      notes in ${ns.span}: ${ns.named.join(", ")}`
            + (ns.extra > 0 ? ` (+${ns.extra} more in span — list_notes to see them)` : "")
          : `      notes in ${ns.span}: none — answer from structured data or mark not evaluable,`
            + " do not cite a note from outside the span",
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
