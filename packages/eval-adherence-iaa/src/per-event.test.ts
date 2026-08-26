import { describe, it, expect } from "vitest";
import { computePerEventMetrics, type EventSide } from "./index.js";

const A: EventSide[] = [
  { patient_id: "p1", event_id: "R-Step@d1@e1", rule_id: "R-Step", anchored: true, verdict: "CONCORDANT" },
  { patient_id: "p1", event_id: "R-Step@d2@e2", rule_id: "R-Step", anchored: true, verdict: "NON_CONCORDANT" },
  { patient_id: "p1", event_id: "R-FU@d1@e1", rule_id: "R-FU", anchored: true, verdict: "CONCORDANT" },
  { patient_id: "p1", event_id: "R-Spiro@window", rule_id: "R-Spiro", anchored: false, verdict: "CONCORDANT" },
];
const B: EventSide[] = [
  { patient_id: "p1", event_id: "R-Step@d1@e1", rule_id: "R-Step", anchored: true, verdict: "CONCORDANT" },
  { patient_id: "p1", event_id: "R-Step@d2@e2", rule_id: "R-Step", anchored: true, verdict: "CONCORDANT" },
  { patient_id: "p1", event_id: "R-FU@d9@note:x", rule_id: "R-FU", anchored: true, verdict: "NON_CONCORDANT" },
  { patient_id: "p1", event_id: "R-Spiro@window", rule_id: "R-Spiro", anchored: false, verdict: "CONCORDANT" },
];

describe("computePerEventMetrics", () => {
  it("verdict agreement over matched anchored events; enumeration counted per side", () => {
    const m = computePerEventMetrics(A, B);
    const step = m.per_rule.find((r) => r.rule_id === "R-Step")!;
    expect(step.n_matched).toBe(2);
    expect(step.verdict_agreement).toBeCloseTo(0.5);
    const fu = m.per_rule.find((r) => r.rule_id === "R-FU")!;
    expect(fu.n_matched).toBe(0);
    expect(fu.a_only).toBe(1);
    expect(fu.b_only).toBe(1);
    // Anchored only: the window event is excluded from enumeration (plan ERRATA).
    expect(m.enumeration.matched).toBe(2);
    expect(m.enumeration.a_only).toBe(1);
    expect(m.enumeration.b_only).toBe(1);
    expect(m.enumeration.jaccard).toBeCloseTo(2 / 4);
    expect(m.window_rules).toBe(1);
  });

  it("kappa is computed over matched verdict pairs and is finite for a real disagreement", () => {
    const m = computePerEventMetrics(A, B);
    expect(Number.isFinite(m.verdict_kappa)).toBe(true);
  });

  it("not-evaluable is its own label, distinct from an unscored event", () => {
    const a: EventSide[] = [
      { patient_id: "p", event_id: "R@d@1", rule_id: "R", anchored: true, evaluable: false },
      { patient_id: "p", event_id: "R@d@2", rule_id: "R", anchored: true },
    ];
    const b: EventSide[] = [
      { patient_id: "p", event_id: "R@d@1", rule_id: "R", anchored: true },
      { patient_id: "p", event_id: "R@d@2", rule_id: "R", anchored: true },
    ];
    const m = computePerEventMetrics(a, b);
    const r = m.per_rule.find((x) => x.rule_id === "R")!;
    // d@1: NOT_EVALUABLE vs NONE = disagreement. d@2: NONE vs NONE = agreement.
    expect(r.n_matched).toBe(2);
    expect(r.verdict_agreement).toBeCloseTo(0.5);
  });

  it("patient_id namespaces event_ids (same event_id across patients never matches)", () => {
    const a: EventSide[] = [{ patient_id: "p1", event_id: "R@d@1", rule_id: "R", anchored: true, verdict: "CONCORDANT" }];
    const b: EventSide[] = [{ patient_id: "p2", event_id: "R@d@1", rule_id: "R", anchored: true, verdict: "CONCORDANT" }];
    const m = computePerEventMetrics(a, b);
    expect(m.enumeration.matched).toBe(0);
    expect(m.enumeration.a_only).toBe(1);
    expect(m.enumeration.b_only).toBe(1);
  });
});
