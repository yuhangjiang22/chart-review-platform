import { describe, it, expect } from "vitest";
import type { RuleEvent } from "@chart-review/platform-types";
import { buildEventWorklistBlock } from "./event-prompt.js";

const anchored: RuleEvent = {
  event_id: "R-Step@2024-11-14@encounters:18",
  rule_id: "R-Step",
  anchor: { type: "asthma_encounters", date: "2024-11-14", origin: "omop", ref: "encounters:18", meta: { kind: "ed" } },
};
const windowEv: RuleEvent = {
  event_id: "R-Spiro@window",
  rule_id: "R-Spiro",
  anchor: { type: "window", origin: "omop" },
};

describe("buildEventWorklistBlock", () => {
  it("lists only anchored events, with ids, dates, and meta", () => {
    const block = buildEventWorklistBlock([anchored, windowEv]);
    expect(block).toContain("R-Step@2024-11-14@encounters:18");
    expect(block).toContain("2024-11-14");
    expect(block).toContain("kind=ed");
    expect(block).not.toContain("R-Spiro@window");
    expect(block).toContain("set_event_answer");
  });

  it("returns empty string when no anchored events exist (legacy tasks — prompt unchanged)", () => {
    expect(buildEventWorklistBlock([windowEv])).toBe("");
  });
});

// The whole point of the block: tell the agent WHICH questions each event
// needs. Without this the agent had to infer it, and on a live run it
// answered one event with another event's question and left four with nothing.
describe("per-event required questions", () => {
  const STEP_RULE = {
    rule_id: "R-Step",
    description: "d",
    event_anchor: "visits",
    verdict_if: 'StepMatch == "matches"',
    event_evaluable_if: "ControlLevel is present",
    event_scoped_questions: ["StepMatch", "ControlLevel"],
  };

  it("names the answer questions and the applicability questions separately", () => {
    const block = buildEventWorklistBlock([anchored], [STEP_RULE as never]);
    expect(block).toMatch(/^ {6}answer: StepMatch/m);
    expect(block).toContain("decides: ControlLevel");
  });

  it("states that BOTH groups are required, not just the verdict question", () => {
    // The first wording tied the consequence to the `answer:` group only, so a
    // live agent read `decides:` as informational: it committed the verdict
    // question for all eight anchored events and the control level for none,
    // leaving both per-event rules with zero verdicts.
    const block = buildEventWorklistBlock([anchored], [STEP_RULE as never]);
    expect(block).toMatch(/Both groups are required/);
    expect(block).toMatch(/missing EITHER is dropped/);
    expect(block).toMatch(/not optional/);
  });

  it("omits the needs line when the rule declares no event-scoped questions", () => {
    const bare = { ...STEP_RULE, event_scoped_questions: [], event_evaluable_if: undefined };
    const block = buildEventWorklistBlock([anchored], [bare as never]);
    // The per-event needs line is indented under its event; the block header
    // legitimately mentions `answers:[...]` in the tool-call shape.
    expect(block).not.toMatch(/^ {6}answer: /m);
    expect(block).toContain(anchored.event_id);
  });

  it("still renders without rules (no needs lines, event list intact)", () => {
    const block = buildEventWorklistBlock([anchored]);
    expect(block).toContain(anchored.event_id);
    expect(block).not.toMatch(/^ {6}answer: /m);
  });
});

describe("evidence discipline", () => {
  const RULE = {
    rule_id: "R-Step", description: "d", event_anchor: "visits",
    verdict_if: 'StepMatch == "matches"',
    event_scoped_questions: ["StepMatch"],
  };
  it("requires evidence on every event answer and names both source shapes", () => {
    const block = buildEventWorklistBlock([anchored], [RULE as never]);
    expect(block).toMatch(/EVERY answer needs evidence/);
    expect(block).toMatch(/VERBATIM/);
    expect(block).toMatch(/source:'omop'/);
  });
  it("says what happens when evidence is omitted, rather than only forbidding it", () => {
    // A bare prohibition invites the agent to null the answer to escape the
    // gate — the phenotype path learned that the hard way. Committing the
    // answer and flagging it is the behaviour, so the prompt says so.
    const block = buildEventWorklistBlock([anchored], [RULE as never]);
    expect(block).toMatch(/stored but shown to the reviewer as unevidenced/);
  });
});

describe("per-event note scoping", () => {
  const RULE = {
    rule_id: "R-Step", description: "d", event_anchor: "visits",
    verdict_if: 'StepMatch == "matches"',
    event_scoped_questions: ["StepMatch"],
  };
  const FOLLOWUP = { ...RULE, rule_id: "R-FU", event_window_days: 90 };
  const NOTES = [
    { filename: "2018-08-09__discharge_summary.txt", date: "2018-08-09" },
    { filename: "2021-08-03__telephone_note.txt", date: "2021-08-03" },
    { filename: "2021-09-24__care_management_note.txt", date: "2021-09-24" },
    { filename: "2021-11-02__followup.txt", date: "2021-11-02" },
    { filename: "2022-06-01__later.txt", date: "2022-06-01" },
  ];
  const at = (ruleId: string, date: string, meta?: Record<string, unknown>) => ({
    event_id: `${ruleId}@${date}`, rule_id: ruleId,
    anchor: { type: "visits", date, origin: "omop" as const, ...(meta ? { meta } : {}) },
  });

  it("names the notes in the event's span and EXCLUDES ones from years outside it", () => {
    // The defect: the agent was handed the patient's whole chart with nothing
    // to say which part belonged to which event, and answered a 2021 visit
    // citing a 2018 discharge summary — which passed every automated check,
    // because the quote really was in that note.
    const block = buildEventWorklistBlock([at("R-Step", "2021-09-25") as never], [RULE as never], NOTES);
    expect(block).toContain("2021-08-03__telephone_note.txt");
    expect(block).toContain("2021-09-24__care_management_note.txt");
    expect(block).not.toContain("2018-08-09__discharge_summary.txt");
    expect(block).not.toContain("2022-06-01__later.txt");
  });

  it("extends the span to the end of the rule's judgment window", () => {
    // A follow-up arranged AT the visit is documented in the following weeks,
    // so the span has to reach forward as far as the requirement does.
    const block = buildEventWorklistBlock([at("R-FU", "2021-09-25") as never], [FOLLOWUP as never], NOTES);
    expect(block).toContain("2021-11-02__followup.txt");
  });

  it("uses the ETL deadline as the span end when the anchor carries one", () => {
    const block = buildEventWorklistBlock(
      [at("R-Step", "2021-09-25", { deadline: "2021-11-10" }) as never], [RULE as never], NOTES,
    );
    expect(block).toContain("2021-11-02__followup.txt");
    // The NOTE span runs NOTE_DOC_LAG_DAYS past the judged period — a chart is
    // written after the fact. The judged end itself is unchanged and is what the
    // event line prints as `judge through`.
    expect(block).toContain("… 2021-11-13");
    expect(block).toContain("judge through 2021-11-10");
  });

  it("offers a note filed just AFTER the judged period — documentation lag", () => {
    // The case that motivated the grace: a point-judged event at a 2021-09-25
    // clinic visit was handed five notes, all on or before that day, and the
    // agent went outside its list to cite the next day's ED note. For the control
    // level at that visit, "went to the ED the next day" is the strongest
    // evidence the asthma was not controlled.
    const notes = [
      { filename: "2021-09-24__clinic.txt", date: "2021-09-24" },
      { filename: "2021-09-26__emergency_dept.txt", date: "2021-09-26" },
      { filename: "2021-10-05__later_visit.txt", date: "2021-10-05" },
    ];
    const block = buildEventWorklistBlock([at("R-Step", "2021-09-25") as never], [RULE as never], notes);
    expect(block).toContain("2021-09-26__emergency_dept.txt");
    // Still short: a note ten days later documents a state that may have changed,
    // and belongs to whatever event covers it.
    expect(block).not.toContain("2021-10-05__later_visit.txt");
  });

  it("states the span even when it holds no notes, and says not to reach outside it", () => {
    const block = buildEventWorklistBlock([at("R-Step", "2019-05-05") as never], [RULE as never], NOTES);
    expect(block).toMatch(/notes in .*: none/);
    expect(block).toMatch(/do not cite a note from outside the span/);
  });

  it("caps the named list but keeps the span, so a busy chart does not flood the prompt", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      filename: `2021-09-0${(i % 9) + 1}__note_${i}.txt`, date: `2021-09-0${(i % 9) + 1}`,
    }));
    const block = buildEventWorklistBlock([at("R-Step", "2021-09-25") as never], [RULE as never], many);
    expect(block).toMatch(/\+15 more in span/);
  });

  it("renders without a note list at all (phenotype-style callers pass none)", () => {
    const block = buildEventWorklistBlock([at("R-Step", "2021-09-25") as never], [RULE as never]);
    expect(block).toContain("R-Step@2021-09-25");
    expect(block).toMatch(/notes in .*: none/);
  });
});
