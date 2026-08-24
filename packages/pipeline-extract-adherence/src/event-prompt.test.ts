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
