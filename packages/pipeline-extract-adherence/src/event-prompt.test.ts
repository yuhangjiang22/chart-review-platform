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
