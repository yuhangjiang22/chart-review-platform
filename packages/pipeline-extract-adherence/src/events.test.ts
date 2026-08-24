import { describe, it, expect } from "vitest";
import type { RuleDefinition } from "@chart-review/rule-engine";
import { expandEventWorklist, toAnchorEntries, type AnchorEntry } from "./events.js";

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
      type: "visits", date: "2024-11-14", origin: "omop", ref: "encounters:18", meta: { kind: "ed" },
    });
  });

  it("a missing anchor list yields zero anchored events (rollup will EXCLUDE), not a crash", () => {
    const wl = expandEventWorklist([anchoredRule], {});
    expect(wl).toEqual([]);
  });

  it("dedupes the same event_id across overlapping anchor lists, first-wins", () => {
    const rule: RuleDefinition = {
      rule_id: "R-Overlap",
      description: "d",
      verdict_if: "x == true",
      event_anchor: ["ocs_bursts", "obligation_points"],
    };
    const shared: AnchorEntry = { date: "2024-11-14", ref: "drugs:9", meta: { kind: "burst" } };
    const overlapping: Record<string, AnchorEntry[]> = {
      ocs_bursts: [shared],
      obligation_points: [shared],
    };
    const wl = expandEventWorklist([rule], overlapping);
    expect(wl).toHaveLength(1);
    expect(wl[0].event_id).toBe("R-Overlap@2024-11-14@drugs:9");
    // first list wins the anchor type
    expect(wl[0].anchor.type).toBe("ocs_bursts");
  });

  it("a ref-less anchor entry falls back to <name>:<index> in the event_id", () => {
    const rule: RuleDefinition = {
      rule_id: "R-Step",
      description: "d",
      verdict_if: "x == true",
      event_anchor: "visits",
    };
    const noRef: Record<string, AnchorEntry[]> = {
      visits: [{ date: "2024-03-01" }, { date: "2024-03-02" }],
    };
    const wl = expandEventWorklist([rule], noRef);
    expect(wl.map((e) => e.event_id)).toEqual([
      "R-Step@2024-03-01@visits:0",
      "R-Step@2024-03-02@visits:1",
    ]);
  });
});

describe("toAnchorEntries", () => {
  it("narrows raw JSON rows to just objects with a string date", () => {
    const rows: unknown[] = [
      "not an object",
      { ref: "encounters:1" }, // no date
      { date: "2024-01-01", ref: "encounters:2" },
    ];
    expect(toAnchorEntries(rows)).toEqual([{ date: "2024-01-01", ref: "encounters:2" }]);
  });
});
