import { describe, it, expect } from "vitest";
import type { RuleDefinition } from "@chart-review/rule-engine";
import { expandEventWorklist, type AnchorEntry } from "./events.js";

const anchoredRule: RuleDefinition = {
  rule_id: "R-Step",
  description: "d",
  verdict_if: "x == true",
  event_anchor: "visits",
};
const multiAnchorRule: RuleDefinition = {
  rule_id: "R-Followup",
  description: "d",
  verdict_if: "x == true",
  event_anchor: ["visits", "bursts"],
};
const windowRule: RuleDefinition = {
  rule_id: "R-Spiro",
  description: "d",
  verdict_if: "x == true",
};

const anchors: Record<string, AnchorEntry[]> = {
  visits: [
    { date: "2024-02-01", ref: "encounters:3", meta: { kind: "outpatient" } },
    { date: "2024-11-14", ref: "encounters:18", meta: { kind: "ed" } },
  ],
  bursts: [{ date: "2024-11-14", ref: "drugs:9" }],
};

describe("expandEventWorklist", () => {
  it("expands anchored rules over their lists and window rules to one event", () => {
    const wl = expandEventWorklist([anchoredRule, multiAnchorRule, windowRule], anchors);
    expect(wl.map((e) => e.event_id)).toEqual([
      "R-Step@2024-02-01@encounters:3",
      "R-Step@2024-11-14@encounters:18",
      "R-Followup@2024-02-01@encounters:3",
      "R-Followup@2024-11-14@encounters:18",
      "R-Followup@2024-11-14@drugs:9",
      "R-Spiro@window",
    ]);
    expect(wl[1].anchor).toEqual({
      type: "visits", date: "2024-11-14", origin: "omop", ref: "encounters:18",
    });
  });

  it("a missing anchor list yields zero anchored events (rollup will EXCLUDE), not a crash", () => {
    const wl = expandEventWorklist([anchoredRule], {});
    expect(wl).toEqual([]);
  });
});
