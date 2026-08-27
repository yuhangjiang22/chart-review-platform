import { describe, it, expect } from "vitest";
import {
  deriveWindow, groupByOccurrence, anchorKindOf, groupOccurrencesByMonth,
  monthLabel, relativeToAnchor,
  type TimelineEventLite,
} from "./timeline-layout";

const ev = (id: string, ruleId: string, date?: string, type = "asthma_encounters", ref?: string): TimelineEventLite => ({
  event_id: id, rule_id: ruleId,
  anchor: { type, date, origin: "omop", ref },
});

describe("deriveWindow", () => {
  it("spans min..max anchored dates padded 14 days, ignoring undated events", () => {
    const w = deriveWindow([ev("a", "R1", "2025-03-10"), ev("b", "R2", "2026-04-12"), ev("c", "R3")]);
    expect(w.start).toBe("2025-02-24");
    expect(w.end).toBe("2026-04-26");
  });
  it("no dated events → a 365-day window ending today", () => {
    const w = deriveWindow([ev("a", "R1")]);
    const days = (new Date(w.end).getTime() - new Date(w.start).getTime()) / 86400000;
    expect(days).toBe(365);
  });
  it("holds the reported window at a year when the events span only days", () => {
    // Two events a day apart used to report a 30-day window, which read as
    // "the observation period was one month" and made the sparsest charts look
    // the busiest.
    const w = deriveWindow([ev("a", "R1", "2025-09-25"), ev("b", "R2", "2025-09-26")]);
    const days = (new Date(w.end).getTime() - new Date(w.start).getTime()) / 86400000;
    expect(days).toBeGreaterThanOrEqual(365);
  });
  it("extends backward, not forward — the newest event stays near the end", () => {
    const w = deriveWindow([ev("a", "R1", "2025-09-25"), ev("b", "R2", "2025-09-26")]);
    expect(w.end).toBe("2025-10-10"); // 14 days past the last event, no more
  });
});

describe("groupByOccurrence", () => {
  it("collapses the several rules judged on ONE day into ONE occurrence", () => {
    // The defect this fixes: three events on two days used to draw three rows,
    // two of them labelled with the same rule name and nothing to say they
    // were the same visit.
    const occ = groupByOccurrence([
      ev("R-Step@2025-11-15@e2", "R-T2-StepTherapyMatches", "2025-11-15"),
      ev("R-FU@2025-11-15@e2", "R-T2-FollowupScheduled", "2025-11-15"),
      ev("R-FU@2025-11-16@d1", "R-T2-FollowupScheduled", "2025-11-16"),
    ]);
    expect(occ).toHaveLength(2);
    expect(occ[0].events).toHaveLength(1); // 11-16 — newest first
    expect(occ[1].events).toHaveLength(2); // 11-15
  });
  it("orders newest first, matching the source Timeline tab", () => {
    const occ = groupByOccurrence([
      ev("a", "R1", "2025-01-10"),
      ev("b", "R1", "2025-06-10"),
      ev("c", "R1", "2025-03-10"),
    ]);
    expect(occ.map((o) => o.date)).toEqual(["2025-06-10", "2025-03-10", "2025-01-10"]);
  });
  it("sorts the rules within a day deterministically", () => {
    const occ = groupByOccurrence([
      ev("z", "R-T2-StepTherapyMatches", "2025-11-15"),
      ev("a", "R-T1-ControllerForPersistent", "2025-11-15"),
    ]);
    expect(occ[0].events.map((e) => e.rule_id)).toEqual([
      "R-T1-ControllerForPersistent", "R-T2-StepTherapyMatches",
    ]);
  });
  it("drops window and undated events — they have no place on a chronology", () => {
    expect(groupByOccurrence([
      ev("R-Spiro@window", "R-Spiro", undefined, "window"),
      ev("R2@invalid@e2", "R2", "Nov 15, 2025"),
    ])).toEqual([]);
  });
  it("lists the distinct kinds that day, so the headline can name what happened", () => {
    const withMeta = (id: string, rid: string, date: string, type: string, kind?: string): TimelineEventLite => ({
      event_id: id, rule_id: rid,
      anchor: { type, date, origin: "omop", ...(kind ? { meta: { kind } } : {}) },
    });
    const occ = groupByOccurrence([
      withMeta("a", "R-T2-StepTherapyMatches", "2025-11-15", "asthma_encounters", "ed"),
      withMeta("b", "R-T2-FollowupScheduled", "2025-11-15", "ocs_bursts"),
    ]);
    expect(occ[0].kinds).toEqual(["ed", "ocs_bursts"]);
  });
});

describe("anchorKindOf", () => {
  it("reads the ED/outpatient split from anchor.meta", () => {
    expect(anchorKindOf({
      event_id: "a", rule_id: "R",
      anchor: { type: "asthma_encounters", date: "2025-01-01", origin: "omop", meta: { kind: "ed" } },
    })).toBe("ed");
  });
  it("falls back to the anchor list name for everything else", () => {
    expect(anchorKindOf({
      event_id: "b", rule_id: "R",
      anchor: { type: "obligation_points", date: "2025-01-01", origin: "omop" },
    })).toBe("obligation_points");
  });
});

describe("groupOccurrencesByMonth", () => {
  it("buckets by month, preserving the newest-first order", () => {
    const occ = groupByOccurrence([
      ev("a", "R1", "2025-11-04"),
      ev("b", "R1", "2025-11-15"),
      ev("c", "R1", "2025-12-16"),
    ]);
    const groups = groupOccurrencesByMonth(occ);
    expect(groups.map((g) => g.key)).toEqual(["2025-12", "2025-11"]);
    expect(groups[0].label).toBe("DECEMBER 2025");
    expect(groups[1].occurrences.map((o) => o.date)).toEqual(["2025-11-15", "2025-11-04"]);
  });
  it("re-opens a month group rather than silently reordering non-adjacent runs", () => {
    // The input is expected sorted, so a month should appear once — but if it
    // isn't, dates must not be moved into the wrong group to tidy it up.
    const groups = groupOccurrencesByMonth([
      { key: "2025-11-15", date: "2025-11-15", kinds: [], events: [] },
      { key: "2025-12-01", date: "2025-12-01", kinds: [], events: [] },
      { key: "2025-11-04", date: "2025-11-04", kinds: [], events: [] },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["2025-11", "2025-12", "2025-11"]);
  });
  it("no occurrences → no groups", () => {
    expect(groupOccurrencesByMonth([])).toEqual([]);
  });
});

describe("monthLabel", () => {
  it("renders an uppercase EN month and year", () => {
    expect(monthLabel("2021-09")).toBe("SEPTEMBER 2021");
    expect(monthLabel("2021-01")).toBe("JANUARY 2021");
    expect(monthLabel("2021-12")).toBe("DECEMBER 2021");
  });
});

describe("relativeToAnchor", () => {
  it("labels the reference point itself 'index'", () => {
    expect(relativeToAnchor("2021-11-23", "2021-11-23")).toBe("index");
  });
  it("uses days under 30 and months beyond", () => {
    expect(relativeToAnchor("2021-10-26", "2021-11-23")).toBe("-28d");
    expect(relativeToAnchor("2021-09-23", "2021-11-23")).toBe("-2mo");
  });
  it("signs a future date", () => {
    expect(relativeToAnchor("2021-11-25", "2021-11-23")).toBe("+2d");
  });
  it("returns null when either date is unusable, rather than throwing", () => {
    expect(relativeToAnchor(undefined, "2021-11-23")).toBeNull();
    expect(relativeToAnchor("2021-11-23", undefined)).toBeNull();
    expect(relativeToAnchor("Nov 23, 2021", "2021-11-23")).toBeNull();
  });
});
