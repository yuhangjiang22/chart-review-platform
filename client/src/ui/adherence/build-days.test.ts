import { describe, it, expect } from "vitest";
import { buildAdherenceDays } from "./build-days";
import type { RuleEvent } from "./types";

const ev = (
  id: string, ruleId: string, date: string,
  over: Partial<RuleEvent> = {},
  anchorOver: Partial<RuleEvent["anchor"]> = {},
): RuleEvent => ({
  event_id: id, rule_id: ruleId,
  anchor: { type: "asthma_encounters", date, origin: "omop", ...anchorOver },
  ...over,
});

const NONE = new Set<string>();

describe("buildAdherenceDays — grouping", () => {
  it("collapses the several rules judged on ONE day into ONE entry", () => {
    // The defect this shape fixes: one visit with two rules anchored on it
    // used to appear as two timeline entries, each headlined with a rule name
    // and nothing to say they were the same visit.
    const days = buildAdherenceDays({
      events: [
        ev("a", "R-T2-StepTherapyMatches", "2025-11-15"),
        ev("b", "R-T2-FollowupScheduled", "2025-11-15"),
        ev("c", "R-T2-FollowupScheduled", "2025-11-16"),
      ],
      mode: "review", validatedEvents: NONE,
    });
    expect(days).toHaveLength(2);
    expect(days[0].date).toBe("2025-11-16"); // newest first
    expect(days[1].rules).toHaveLength(2);
  });

  it("names what happened, not the rule — and every kind present that day", () => {
    const days = buildAdherenceDays({
      events: [
        ev("a", "R-T2-StepTherapyMatches", "2025-11-15", {}, { meta: { kind: "ed" } }),
        ev("b", "R-T2-FollowupScheduled", "2025-11-15", {}, { type: "ocs_bursts" }),
      ],
      mode: "review", validatedEvents: NONE,
    });
    expect(days[0].kinds).toEqual(["ED visit", "Steroid course"]);
  });

  it("drops window and undated events — they have no place on a chronology", () => {
    const days = buildAdherenceDays({
      events: [
        ev("w", "R-T1-SpirometryWithin24mo", "", {}, { type: "window", date: undefined }),
        ev("d", "R-T2-FollowupScheduled", "", {}, { date: undefined }),
      ],
      mode: "review", validatedEvents: NONE,
    });
    expect(days).toEqual([]);
  });

  it("orders rules within a day deterministically", () => {
    const days = buildAdherenceDays({
      events: [
        ev("z", "R-T2-StepTherapyMatches", "2025-11-15"),
        ev("a", "R-T1-ControllerForPersistent", "2025-11-15"),
      ],
      mode: "review", validatedEvents: NONE,
    });
    expect(days[0].rules.map((r) => r.label)).toEqual([
      "ControllerForPersistent", "StepTherapyMatches",
    ]);
  });
});

describe("buildAdherenceDays — review mode", () => {
  it("shows the verdict, unmuted", () => {
    const days = buildAdherenceDays({
      events: [ev("a", "R-T2-StepTherapyMatches", "2025-11-15", { evaluable: true, verdict: "NON_CONCORDANT" })],
      mode: "review", validatedEvents: NONE,
    });
    expect(days[0].rules[0]).toMatchObject({ verdict: "NON_CONCORDANT", muted: false });
  });

  it("distinguishes not-evaluable from a verdict, and mutes it", () => {
    // "We could not judge this" must never read with the weight of "the
    // guideline was violated".
    const days = buildAdherenceDays({
      events: [ev("a", "R-T2-StepTherapyMatches", "2025-11-15", { evaluable: false, evaluable_reason: "no control picture" })],
      mode: "review", validatedEvents: NONE,
    });
    expect(days[0].rules[0]).toMatchObject({ verdict: "NOT EVALUABLE", muted: true });
  });

  it("distinguishes not-yet-scored from both, and mutes it", () => {
    const days = buildAdherenceDays({
      events: [ev("a", "R-T2-StepTherapyMatches", "2025-11-15")],
      mode: "review", validatedEvents: NONE,
    });
    expect(days[0].rules[0]).toMatchObject({ verdict: "NOT SCORED", muted: true });
  });

  it("marks a validated event", () => {
    const days = buildAdherenceDays({
      events: [ev("a", "R-T2-StepTherapyMatches", "2025-11-15", { verdict: "CONCORDANT" })],
      mode: "review", validatedEvents: new Set(["a"]),
    });
    expect(days[0].rules[0].validated).toBe(true);
  });
});

describe("buildAdherenceDays — blind mode never emits agent output", () => {
  // This is the load-bearing test for gold collection: a blind annotator must
  // not see what the agent concluded, and the guarantee is that the verdict
  // text is NEVER BUILT rather than hidden downstream by styling.
  const agentScored: RuleEvent[] = [
    ev("a", "R-T2-StepTherapyMatches", "2025-11-15", { evaluable: true, verdict: "NON_CONCORDANT" }),
    ev("b", "R-T2-FollowupScheduled", "2025-11-15", { evaluable: false }),
  ];

  it("emits no verdict, no muted flag, no validated flag", () => {
    const days = buildAdherenceDays({ events: agentScored, mode: "blind", validatedEvents: new Set(["a"]) });
    for (const r of days[0].rules) {
      expect(r.verdict).toBeUndefined();
      expect(r.muted).toBeUndefined();
      expect(r.validated).toBeUndefined();
    }
  });

  it("still lists the days and rules — the annotator needs the work-list", () => {
    const days = buildAdherenceDays({ events: agentScored, mode: "blind", validatedEvents: NONE });
    expect(days[0].kinds).toEqual(["Asthma visit"]);
    expect(days[0].rules.map((r) => r.event_id).sort()).toEqual(["a", "b"]);
  });

  it("no verdict string survives anywhere in the output", () => {
    const days = buildAdherenceDays({ events: agentScored, mode: "blind", validatedEvents: NONE });
    const dumped = JSON.stringify(days);
    for (const leak of ["CONCORDANT", "NON_CONCORDANT", "EVALUABLE", "SCORED"]) {
      expect(dumped).not.toContain(leak);
    }
  });
});

describe("buildAdherenceDays — compare mode", () => {
  const canonical = [ev("a", "R-T2-StepTherapyMatches", "2025-11-15", { evaluable: true, verdict: "CONCORDANT" })];

  it("pairs the agent and human sides", () => {
    const days = buildAdherenceDays({
      events: canonical,
      mode: "compare",
      validatedEvents: NONE,
      agentEvents: [ev("a", "R-T2-StepTherapyMatches", "2025-11-15", { evaluable: true, verdict: "NON_CONCORDANT" })],
      compareEvents: [ev("a", "R-T2-StepTherapyMatches", "2025-11-15", { evaluable: true, verdict: "CONCORDANT" })],
    });
    expect(days[0].rules[0].verdict).toBe("A: NC · H: C");
  });

  it("reads the A side from the frozen agent draft, NOT the canonical events", () => {
    // `events` drifts toward reviewer-edited values as validation proceeds;
    // showing that as "A:" manufactures agreement that was never there.
    const days = buildAdherenceDays({
      events: canonical, // reviewer-corrected to CONCORDANT
      mode: "compare",
      validatedEvents: NONE,
      agentEvents: [ev("a", "R-T2-StepTherapyMatches", "2025-11-15", { evaluable: true, verdict: "NON_CONCORDANT" })],
      compareEvents: [],
    });
    expect(days[0].rules[0].verdict).toContain("A: NC");
  });

  it("keeps absent, not-evaluable and not-yet-scored distinct on either side", () => {
    const days = buildAdherenceDays({
      events: [
        ev("absent", "R-T2-A", "2025-11-15", { verdict: "CONCORDANT" }),
        ev("ne", "R-T2-B", "2025-11-15", { verdict: "CONCORDANT" }),
        ev("unscored", "R-T2-C", "2025-11-15", { verdict: "CONCORDANT" }),
      ],
      mode: "compare",
      validatedEvents: NONE,
      agentEvents: [
        ev("absent", "R-T2-A", "2025-11-15", { verdict: "CONCORDANT" }),
        ev("ne", "R-T2-B", "2025-11-15", { verdict: "CONCORDANT" }),
        ev("unscored", "R-T2-C", "2025-11-15", { verdict: "CONCORDANT" }),
      ],
      compareEvents: [
        // "absent" deliberately missing from the human side
        ev("ne", "R-T2-B", "2025-11-15", { evaluable: false }),
        ev("unscored", "R-T2-C", "2025-11-15"),
      ],
    });
    const byLabel = new Map(days[0].rules.map((r) => [r.label, r.verdict]));
    expect(byLabel.get("A")).toContain("H: —");
    expect(byLabel.get("B")).toContain("H: NE");
    expect(byLabel.get("C")).toContain("H: ?");
  });

  it("falls back to the canonical events for the A side when no shadow is supplied", () => {
    const days = buildAdherenceDays({
      events: canonical, mode: "compare", validatedEvents: NONE, compareEvents: [],
    });
    expect(days[0].rules[0].verdict).toBe("A: C · H: —");
  });
});
