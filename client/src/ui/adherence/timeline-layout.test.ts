import { describe, it, expect } from "vitest";
import {
  deriveWindow, datePercent, monthTicks, clinicalAnchors, assignLanes, cardHalfPct,
  type TimelineEventLite,
  type TimelineWindow,
} from "./timeline-layout";

const ev = (id: string, ruleId: string, date?: string, type = "asthma_encounters", ref?: string): TimelineEventLite => ({
  event_id: id, rule_id: ruleId,
  anchor: { type, date, origin: "omop", ref },
});

describe("deriveWindow", () => {
  it("spans min..max anchored dates with 14-day padding", () => {
    const w = deriveWindow([ev("a", "R1", "2025-03-10"), ev("b", "R2", "2026-04-12"), ev("c", "R3")]);
    expect(w.start).toBe("2025-02-24");
    expect(w.end).toBe("2026-04-26");
  });
  it("falls back to a 1-year window ending today when no dated events", () => {
    const w = deriveWindow([ev("a", "R1")]);
    expect(new Date(w.end).getTime() - new Date(w.start).getTime()).toBe(365 * 86400000);
  });
});

describe("datePercent", () => {
  it("maps start→0, end→100, midpoint→50", () => {
    const w = { start: "2025-01-01", end: "2025-12-31" };
    expect(datePercent("2025-01-01", w)).toBe(0);
    expect(datePercent("2025-12-31", w)).toBe(100);
    expect(datePercent("2025-07-02", w)).toBeCloseTo(50, 0);
  });
  it("clamps out-of-window dates", () => {
    const w = { start: "2025-01-01", end: "2025-12-31" };
    expect(datePercent("2024-06-01", w)).toBe(0);
    expect(datePercent("2026-06-01", w)).toBe(100);
  });
  it("returns 0 for invalid dates without throwing", () => {
    const w = { start: "2025-01-01", end: "2025-12-31" };
    expect(datePercent("Nov 15, 2025", w)).toBe(0);
    expect(datePercent("unknown", w)).toBe(0);
  });
});

describe("monthTicks", () => {
  it("yields one tick per month boundary with EN month labels and ISO dates", () => {
    const ticks = monthTicks({ start: "2025-11-15", end: "2026-02-15" });
    expect(ticks.map((t) => t.label)).toEqual(["Dec", "Jan", "Feb"]);
    expect(ticks[0].percent).toBeGreaterThan(0);
    expect(ticks.map((t) => t.date)).toEqual(["2025-12-01", "2026-01-01", "2026-02-01"]);
  });
  it("returns window endpoints as fallback ticks when no month boundary falls inside", () => {
    const ticks = monthTicks({ start: "2025-11-15", end: "2025-11-25" });
    expect(ticks).toHaveLength(2);
    expect(ticks[0].percent).toBe(0);
    expect(ticks[0].date).toBe("2025-11-15");
    expect(ticks[1].percent).toBe(100);
    expect(ticks[1].date).toBe("2025-11-25");
  });
  it("excludes the end boundary (< end, not <=)", () => {
    const ticks = monthTicks({ start: "2025-01-01", end: "2026-01-01" });
    // Should include Dec 1st but NOT Jan 1 (the end boundary).
    expect(ticks.map((t) => t.date)).not.toContain("2026-01-01");
    expect(ticks.map((t) => t.label)).not.toContain("Jan");
  });
});

describe("clinicalAnchors", () => {
  it("dedupes by date+ref+kind and marks kind from type", () => {
    const a = clinicalAnchors([
      ev("R1@2025-11-15@encounters:12201", "R1", "2025-11-15", "asthma_encounters", "encounters:12201"),
      ev("R2@2025-11-15@encounters:12201", "R2", "2025-11-15", "asthma_encounters", "encounters:12201"),
      ev("R2@2025-03-10@drugs:9104", "R2", "2025-03-10", "ocs_bursts", "drugs:9104"),
    ]);
    expect(a).toHaveLength(2);
    expect(a.map((x) => x.kind).sort()).toEqual(["encounter", "burst"].sort());
  });
  it("skips invalid dates without throwing", () => {
    const a = clinicalAnchors([
      ev("R1@2025-11-15@encounters:12201", "R1", "2025-11-15", "asthma_encounters", "encounters:12201"),
      ev("R2@invalid@encounters:12202", "R2", "Nov 15, 2025", "asthma_encounters", "encounters:12202"),
    ]);
    expect(a).toHaveLength(1);
    expect(a[0].date).toBe("2025-11-15");
  });
});

describe("assignLanes", () => {
  it("splits rules across above/below (sorted by rule_id) and packs overlapping cards into sub-lanes", () => {
    const events = [
      ev("R-Step@2025-11-04@e1", "R-T2-StepTherapyMatches", "2025-11-04"),
      ev("R-Step@2025-11-15@e2", "R-T2-StepTherapyMatches", "2025-11-15"),
      ev("R-FU@2025-11-15@e2", "R-T2-FollowupScheduled", "2025-11-15"),
      ev("R-Ctrl@2025-11-15@d1", "R-T1-ControllerForPersistent", "2025-11-15"),
    ];
    const lanes = assignLanes(events, { start: "2025-09-01", end: "2026-05-01" }, 12);
    // Sorted rule_ids: ["R-T1-ControllerForPersistent", "R-T2-FollowupScheduled", "R-T2-StepTherapyMatches"]
    // → above, below, above respectively
    const step = lanes.get("R-Step@2025-11-04@e1")!;
    expect(step.side).toBe("above");
    const fu = lanes.get("R-FU@2025-11-15@e2")!;
    expect(fu.side).toBe("below");
    // Same-side, same-date cards land in different sub-lanes.
    expect(lanes.get("R-Step@2025-11-15@e2")!.lane).not.toBe(lanes.get("R-Ctrl@2025-11-15@d1")!.lane);
    // Overlapping different-date cards on one side also bump.
    expect(lanes.get("R-Step@2025-11-04@e1")!.lane).not.toBe(lanes.get("R-Step@2025-11-15@e2")!.lane);
  });
  it("window-anchored events get no lane entry", () => {
    const lanes = assignLanes([ev("R-Spiro@window", "R-Spiro", undefined, "window")], { start: "2025-01-01", end: "2026-01-01" }, 12);
    expect(lanes.size).toBe(0);
  });
  it("skips events with invalid dates without throwing", () => {
    const lanes = assignLanes([
      ev("R1@2025-11-15@e1", "R1", "2025-11-15"),
      ev("R2@invalid@e2", "R2", "Nov 15, 2025"),
    ], { start: "2025-01-01", end: "2026-01-01" }, 12);
    expect(lanes.size).toBe(1);
    expect(lanes.get("R1@2025-11-15@e1")).toBeDefined();
  });
});

describe("cardHalfPct", () => {
  it("150px card at a 1250px track → exactly 6%", () => {
    expect(cardHalfPct(1250, 150)).toBe(6);
  });
  it("150px card at a 700px track → ~10.714% (150/700*50)", () => {
    // (150 / 700) * 50 = 10.714285714285714 — computed independently, not
    // re-derived from the function under test.
    expect(cardHalfPct(700, 150)).toBeCloseTo(10.714285714285714, 9);
  });
  it("non-positive trackW (pre-measure / hidden pane) falls back to the 1250px-track value", () => {
    expect(cardHalfPct(0, 150)).toBe(6);
    expect(cardHalfPct(-5, 150)).toBe(6);
  });
});

describe("cardHalfPct × assignLanes — a narrow track bumps overlapping cards, a wide one doesn't", () => {
  // 371-day window, two same-rule events 49 days apart.
  //   p1 = 100/371*100 = 26.954177897574123
  //   p2 = 149/371*100 = 40.16172506738545
  //   diff = 49/371*100 = 13.207547169811324 (percent-of-track separation)
  // At a 700px track, cardHalfPct(700,150) ≈ 10.714 → 2×halfPct ≈ 21.429,
  //   which is > the 13.21 separation, so the cards' spans overlap and
  //   assignLanes must bump the second card to a new sub-lane.
  // At a 1250px track, cardHalfPct(1250,150) = 6 → 2×halfPct = 12, which is
  //   < the 13.21 separation, so the spans do NOT overlap and both cards
  //   land in the same sub-lane.
  const DAY = 86400000;
  const isoDate = (t: number) => new Date(t).toISOString().slice(0, 10);
  const winStartMs = new Date("2025-01-01T00:00:00.000Z").getTime();
  const win: TimelineWindow = { start: "2025-01-01", end: isoDate(winStartMs + 371 * DAY) };
  const d1 = isoDate(winStartMs + 100 * DAY); // 2025-04-11
  const d2 = isoDate(winStartMs + 149 * DAY); // 2025-05-30 — 49 days after d1
  const events: TimelineEventLite[] = [
    ev("e1", "R-X", d1),
    ev("e2", "R-X", d2),
  ];

  it("at a 700px track, the two events collide into different lanes", () => {
    const lanes = assignLanes(events, win, cardHalfPct(700, 150));
    const l1 = lanes.get("e1")!;
    const l2 = lanes.get("e2")!;
    expect(l1.side).toBe(l2.side);
    expect(l1.lane).not.toBe(l2.lane);
  });

  it("at a 1250px track, the two events fit in the same lane", () => {
    const lanes = assignLanes(events, win, cardHalfPct(1250, 150));
    const l1 = lanes.get("e1")!;
    const l2 = lanes.get("e2")!;
    expect(l1.side).toBe(l2.side);
    expect(l1.lane).toBe(l2.lane);
  });
});
