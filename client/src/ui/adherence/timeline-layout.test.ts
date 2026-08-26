import { describe, it, expect } from "vitest";
import {
  deriveWindow, datePercent, monthTicks, clinicalAnchors, assignLanes,
  type TimelineEventLite,
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
});

describe("monthTicks", () => {
  it("yields one tick per month boundary with EN month labels", () => {
    const ticks = monthTicks({ start: "2025-11-15", end: "2026-02-15" });
    expect(ticks.map((t) => t.label)).toEqual(["Dec", "Jan", "Feb"]);
    expect(ticks[0].percent).toBeGreaterThan(0);
  });
});

describe("clinicalAnchors", () => {
  it("dedupes by date+ref and marks kind from meta", () => {
    const a = clinicalAnchors([
      ev("R1@2025-11-15@encounters:12201", "R1", "2025-11-15", "asthma_encounters", "encounters:12201"),
      ev("R2@2025-11-15@encounters:12201", "R2", "2025-11-15", "asthma_encounters", "encounters:12201"),
      ev("R2@2025-03-10@drugs:9104", "R2", "2025-03-10", "ocs_bursts", "drugs:9104"),
    ]);
    expect(a).toHaveLength(2);
    expect(a.map((x) => x.kind).sort()).toEqual(["encounter", "burst"].sort());
  });
});

describe("assignLanes", () => {
  it("splits rules across above/below and packs overlapping cards into sub-lanes", () => {
    const events = [
      ev("R-Step@2025-11-04@e1", "R-T2-StepTherapyMatches", "2025-11-04"),
      ev("R-Step@2025-11-15@e2", "R-T2-StepTherapyMatches", "2025-11-15"),
      ev("R-FU@2025-11-15@e2", "R-T2-FollowupScheduled", "2025-11-15"),
      ev("R-Ctrl@2025-11-15@d1", "R-T1-ControllerForPersistent", "2025-11-15"),
    ];
    const lanes = assignLanes(events, { start: "2025-09-01", end: "2026-05-01" }, 12);
    const step = lanes.get("R-Step@2025-11-04@e1")!;
    expect(step.side).toBe("above");
    const fu = lanes.get("R-FU@2025-11-15@e2")!;
    expect(fu.side).toBe("below");
    // Same-date cards on the same side land in different sub-lanes.
    const sameSide = [...lanes.values()].filter((l) => l.side === "above");
    const at1115 = sameSide.filter((l) => Math.abs(l.percent - sameSide[0].percent) < 0.001);
    expect(new Set(at1115.map((l) => l.lane)).size).toBe(at1115.length);
  });
  it("window-anchored events get no lane entry", () => {
    const lanes = assignLanes([ev("R-Spiro@window", "R-Spiro", undefined, "window")], { start: "2025-01-01", end: "2026-01-01" }, 12);
    expect(lanes.size).toBe(0);
  });
});
