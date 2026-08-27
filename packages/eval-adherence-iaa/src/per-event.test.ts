import { describe, it, expect } from "vitest";
import { computePerEventMetrics, type EventSide } from "./index.js";

// ── Fixtures shared by the enumeration / verdict-agreement tests ───────────

const A: EventSide[] = [
  { patient_id: "p1", event_id: "R-Step@d1@e1", rule_id: "R-Step", anchored: true, origin: "omop", verdict: "CONCORDANT" },
  { patient_id: "p1", event_id: "R-Step@d2@e2", rule_id: "R-Step", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
  { patient_id: "p1", event_id: "R-FU@d1@e1", rule_id: "R-FU", anchored: true, origin: "omop", verdict: "CONCORDANT" },
  { patient_id: "p1", event_id: "R-Spiro@window", rule_id: "R-Spiro", anchored: false, origin: "omop", verdict: "CONCORDANT" },
];
const B: EventSide[] = [
  { patient_id: "p1", event_id: "R-Step@d1@e1", rule_id: "R-Step", anchored: true, origin: "omop", verdict: "CONCORDANT" },
  { patient_id: "p1", event_id: "R-Step@d2@e2", rule_id: "R-Step", anchored: true, origin: "omop", verdict: "CONCORDANT" },
  { patient_id: "p1", event_id: "R-FU@d9@note:x", rule_id: "R-FU", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
  { patient_id: "p1", event_id: "R-Spiro@window", rule_id: "R-Spiro", anchored: false, origin: "omop", verdict: "CONCORDANT" },
];

describe("computePerEventMetrics — enumeration + verdict agreement (ERRATA)", () => {
  it("verdict agreement over matched anchored+scored events; enumeration counted per side; window events excluded", () => {
    const m = computePerEventMetrics(A, B);

    const step = m.per_rule.find((r) => r.rule_id === "R-Step")!;
    expect(step.n_matched).toBe(2);
    expect(step.n_scored).toBe(2);
    expect(step.verdict_agreement).toBeCloseTo(0.5);

    const fu = m.per_rule.find((r) => r.rule_id === "R-FU")!;
    expect(fu.n_matched).toBe(0);
    expect(fu.n_scored).toBe(0);
    expect(Number.isNaN(fu.verdict_agreement)).toBe(true);
    expect(fu.a_only).toBe(1);
    expect(fu.b_only).toBe(1);

    // A pure-window rule still gets a row (never absent), zeroed because
    // none of its events are anchored.
    const spiro = m.per_rule.find((r) => r.rule_id === "R-Spiro")!;
    expect(spiro.n_matched).toBe(0);
    expect(spiro.a_only).toBe(0);
    expect(spiro.b_only).toBe(0);

    // Anchored only: the window event is excluded from enumeration (plan ERRATA).
    expect(m.enumeration.matched).toBe(2);
    expect(m.enumeration.a_only).toBe(1);
    expect(m.enumeration.b_only).toBe(1);
    expect(m.enumeration.jaccard).toBeCloseTo(2 / 4);
    expect(m.window_rules).toBe(1);

    // Global verdict population: only R-Step's 2 scored matched pairs
    // (R-FU has no matched pairs; R-Spiro is window-excluded).
    expect(m.verdict_n).toBe(2);
  });

  it("kappa is NaN with reason constant_rater_b when B's scored population never varies — even though a real disagreement is present (Critical 2, Task 7 re-review)", () => {
    const m = computePerEventMetrics(A, B);
    // R-Step's 2 scored pairs: A=[CONCORDANT, NON_CONCORDANT] varies;
    // B=[CONCORDANT, CONCORDANT] is constant. Before the Critical 2 fix this
    // silently computed kappa=0 here (the union-of-both-raters check saw 2
    // distinct labels total and let it through) — indistinguishable from a
    // real "measured chance-level agreement" 0 when it's actually "B's
    // marginal can't support a chance correction at all". This shared
    // ERRATA fixture happens to be a live instance of the exact bug.
    expect(Number.isNaN(m.verdict_kappa)).toBe(true);
    expect(m.verdict_kappa_reason).toBe("constant_rater_b");
    expect(m.verdict_n).toBe(2);
    expect(m.verdict_agreement).toBeCloseTo(0.5);
  });

  it("NOT_EVALUABLE is its own label distinct from an unscored (NONE) event; NONE/NONE pairs are excluded from the scored population (C2)", () => {
    const a: EventSide[] = [
      { patient_id: "p", event_id: "R@d@1", rule_id: "R", anchored: true, origin: "omop", evaluable: false }, // NOT_EVALUABLE
      { patient_id: "p", event_id: "R@d@2", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" }, // scored, agrees
      { patient_id: "p", event_id: "R@d@3", rule_id: "R", anchored: true, origin: "omop" }, // NONE (unreached stub)
    ];
    const b: EventSide[] = [
      { patient_id: "p", event_id: "R@d@1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" }, // scored: NOT_EVALUABLE vs CONCORDANT = disagreement, IS in the scored population
      { patient_id: "p", event_id: "R@d@2", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" }, // agrees
      { patient_id: "p", event_id: "R@d@3", rule_id: "R", anchored: true, origin: "omop" }, // NONE — matched pair, but excluded from the scored population
    ];
    const m = computePerEventMetrics(a, b);
    const r = m.per_rule.find((x) => x.rule_id === "R")!;

    expect(r.n_matched).toBe(3);
    expect(r.n_scored).toBe(2); // d@3's NONE/NONE pair does NOT count
    expect(r.verdict_agreement).toBeCloseTo(0.5); // d@1 disagrees, d@2 agrees
    expect(r.disagreements).toEqual([
      { patient_id: "p", event_id: "R@d@1", a: "NOT_EVALUABLE", b: "CONCORDANT" },
    ]);

    expect(m.n_unscored_a).toBe(1); // d@3 only
    expect(m.n_unscored_b).toBe(1); // d@3 only
    expect(m.n_unscored_both).toBe(1); // d@3
    expect(m.completeness_a).toBeCloseTo(2 / 3);
    expect(m.completeness_b).toBeCloseTo(2 / 3);
  });

  it("patient_id namespaces event_ids (same event_id across patients never matches)", () => {
    const a: EventSide[] = [{ patient_id: "p1", event_id: "R@d@1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" }];
    const b: EventSide[] = [{ patient_id: "p2", event_id: "R@d@1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" }];
    const m = computePerEventMetrics(a, b);
    expect(m.enumeration.matched).toBe(0);
    expect(m.enumeration.a_only).toBe(1);
    expect(m.enumeration.b_only).toBe(1);
  });
});

describe("computePerEventMetrics — empty / degenerate populations (priority tests 3-4)", () => {
  it("empty inputs on both sides never throw and report NaN, not 0, for undefined ratios", () => {
    const m = computePerEventMetrics([], []);
    expect(m.per_rule).toEqual([]);
    expect(Number.isNaN(m.verdict_kappa)).toBe(true);
    expect(m.verdict_kappa_reason).toBe("insufficient_pairs");
    expect(m.verdict_n).toBe(0);
    expect(Number.isNaN(m.verdict_agreement)).toBe(true);
    expect(m.n_unscored_a).toBe(0);
    expect(m.n_unscored_b).toBe(0);
    expect(m.n_unscored_both).toBe(0);
    expect(Number.isNaN(m.completeness_a)).toBe(true);
    expect(Number.isNaN(m.completeness_b)).toBe(true);
    expect(m.enumeration.matched).toBe(0);
    expect(m.enumeration.a_only).toBe(0);
    expect(m.enumeration.b_only).toBe(0);
    expect(Number.isNaN(m.enumeration.jaccard)).toBe(true);
    expect(Number.isNaN(m.enumeration.by_origin.omop.jaccard)).toBe(true);
    expect(Number.isNaN(m.enumeration.by_origin.note.jaccard)).toBe(true);
    expect(m.window_rules).toBe(0);
    expect(m.label_marginals).toEqual({ a: {}, b: {} });
    expect(m.confusion).toEqual([]);
  });

  it("one side entirely empty: the other side's anchored events are all *_only, jaccard is a real 0 (not NaN — there IS data, it just doesn't overlap)", () => {
    const b: EventSide[] = [
      { patient_id: "p", event_id: "R@d@1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
    ];
    const m = computePerEventMetrics([], b);
    const r = m.per_rule.find((x) => x.rule_id === "R")!;
    expect(r.n_matched).toBe(0);
    expect(r.n_scored).toBe(0);
    expect(Number.isNaN(r.verdict_agreement)).toBe(true);
    expect(r.a_only).toBe(0);
    expect(r.b_only).toBe(1);
    expect(m.enumeration.matched).toBe(0);
    expect(m.enumeration.b_only).toBe(1);
    expect(m.enumeration.jaccard).toBe(0); // real zero: denom=1, matched=0
    expect(Number.isNaN(m.verdict_kappa)).toBe(true);
    expect(m.verdict_kappa_reason).toBe("insufficient_pairs");
    expect(m.verdict_n).toBe(0);
  });
});

describe("computePerEventMetrics — kappa no-variance handling (C3, priority test 1)", () => {
  function allAgreeConcordant(n: number): [EventSide[], EventSide[]] {
    const a: EventSide[] = [];
    const b: EventSide[] = [];
    for (let i = 0; i < n; i++) {
      a.push({ patient_id: "p", event_id: `R@d@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });
      b.push({ patient_id: "p", event_id: `R@d@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });
    }
    return [a, b];
  }

  it("returns NaN with reason no_label_variance for a small all-agree single-label population (not the old buggy 1)", () => {
    const [a, b] = allAgreeConcordant(2);
    const m = computePerEventMetrics(a, b);
    expect(Number.isNaN(m.verdict_kappa)).toBe(true);
    expect(m.verdict_kappa_reason).toBe("no_label_variance");
    expect(m.verdict_n).toBe(2);
    expect(m.verdict_agreement).toBe(1);
  });

  it("n=200 all-agree single-label is still NaN, but distinguishable from n=2 via verdict_n", () => {
    const [a, b] = allAgreeConcordant(200);
    const m = computePerEventMetrics(a, b);
    expect(Number.isNaN(m.verdict_kappa)).toBe(true);
    expect(m.verdict_kappa_reason).toBe("no_label_variance");
    expect(m.verdict_n).toBe(200); // NOT 2 — same NaN kappa, very different sample size
    expect(m.verdict_agreement).toBe(1);
  });
});

describe("computePerEventMetrics — THE REGRESSION: unscored stubs cannot move kappa (C2, priority test 5)", () => {
  it("20 scored pairs (18 agree, kappa=8/13) plus 30 NONE/NONE stubs: kappa stays 8/13, not the pre-fix ~0.9233", () => {
    const a: EventSide[] = [];
    const b: EventSide[] = [];
    // 16 pairs: both CONCORDANT (agree).
    for (let i = 0; i < 16; i++) {
      a.push({ patient_id: "p", event_id: `R@s@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });
      b.push({ patient_id: "p", event_id: `R@s@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });
    }
    // 2 pairs: both NON_CONCORDANT (agree).
    for (let i = 16; i < 18; i++) {
      a.push({ patient_id: "p", event_id: `R@s@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" });
      b.push({ patient_id: "p", event_id: `R@s@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" });
    }
    // 2 pairs: A=CONCORDANT, B=NON_CONCORDANT (disagree).
    for (let i = 18; i < 20; i++) {
      a.push({ patient_id: "p", event_id: `R@s@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });
      b.push({ patient_id: "p", event_id: `R@s@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" });
    }
    // 30 stubs: seeded on both sides (matched key) but NEITHER side has
    // reached them yet — no verdict on either side.
    for (let i = 0; i < 30; i++) {
      a.push({ patient_id: "p", event_id: `R@stub@${i}`, rule_id: "R", anchored: true, origin: "omop" });
      b.push({ patient_id: "p", event_id: `R@stub@${i}`, rule_id: "R", anchored: true, origin: "omop" });
    }

    const m = computePerEventMetrics(a, b);

    // The stubs must not enter the scored population at all.
    expect(m.verdict_n).toBe(20);
    expect(m.n_unscored_both).toBe(30);
    expect(m.n_unscored_a).toBe(30);
    expect(m.n_unscored_b).toBe(30);
    expect(m.completeness_a).toBeCloseTo(20 / 50);
    expect(m.completeness_b).toBeCloseTo(20 / 50);

    // Raw agreement over the scored population: 18/20 = 0.9 — NOT the
    // pre-fix pooled 48/50 = 0.96 that counting NONE/NONE as agreement
    // produced.
    expect(m.verdict_agreement).toBeCloseTo(0.9);

    // kappa = (pObs - pExp) / (1 - pExp) with pObs=0.9, pExp=0.74 -> 8/13.
    expect(m.verdict_kappa).toBeCloseTo(8 / 13, 6);
    // Pin that the pre-fix inflated value cannot recur. Pre-fix (pooling
    // NONE/NONE into the "agreement" count): pObs=48/50=0.96,
    // pExp=0.4784 -> kappa=0.9233.
    expect(m.verdict_kappa).not.toBeCloseTo(0.9233, 1);
  });
});

describe("computePerEventMetrics — prevalence paradox stays visible, not 'fixed' (C3, priority test 9)", () => {
  it("96% raw agreement with skewed marginals still reports a low kappa, and both numbers are readable together", () => {
    const a: EventSide[] = [];
    const b: EventSide[] = [];
    // n11=95: both CONCORDANT (agree).
    for (let i = 0; i < 95; i++) {
      a.push({ patient_id: "p", event_id: `R@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });
      b.push({ patient_id: "p", event_id: `R@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });
    }
    // n22=1: both NON_CONCORDANT (agree).
    a.push({ patient_id: "p", event_id: "R@95", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" });
    b.push({ patient_id: "p", event_id: "R@95", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" });
    // n12=3: A=CONCORDANT, B=NON_CONCORDANT (disagree).
    for (let i = 96; i < 99; i++) {
      a.push({ patient_id: "p", event_id: `R@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });
      b.push({ patient_id: "p", event_id: `R@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" });
    }
    // n21=1: A=NON_CONCORDANT, B=CONCORDANT (disagree).
    a.push({ patient_id: "p", event_id: "R@99", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" });
    b.push({ patient_id: "p", event_id: "R@99", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });

    const m = computePerEventMetrics(a, b);
    expect(m.verdict_n).toBe(100);
    expect(m.verdict_agreement).toBeCloseTo(0.96, 6);
    // pObs=0.96, pExp=0.9416 -> kappa = 0.0184/0.0584 = 23/73 ~= 0.3151.
    expect(m.verdict_kappa).toBeCloseTo(23 / 73, 6);
    expect(m.verdict_kappa_reason).toBeUndefined(); // a real, computable, low kappa — not a masked/no-data NaN
    expect(m.label_marginals.a).toEqual({ CONCORDANT: 98, NON_CONCORDANT: 2 });
    expect(m.label_marginals.b).toEqual({ CONCORDANT: 96, NON_CONCORDANT: 4 });
  });
});

describe("computePerEventMetrics — origin-stratified enumeration (C4, priority test 7)", () => {
  it("stratifies matched/a_only/b_only/jaccard by anchor.origin; pooled enumeration is the sum of both strata", () => {
    const a: EventSide[] = [
      { patient_id: "p", event_id: "k1", rule_id: "R-Omop", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "k2", rule_id: "R-Omop", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "k3", rule_id: "R-Omop", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "k4", rule_id: "R-Omop", anchored: true, origin: "omop", verdict: "CONCORDANT" }, // a_only
      { patient_id: "p", event_id: "n1", rule_id: "R-Note", anchored: true, origin: "note", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "n2", rule_id: "R-Note", anchored: true, origin: "note", verdict: "CONCORDANT" }, // a_only
    ];
    const b: EventSide[] = [
      { patient_id: "p", event_id: "k1", rule_id: "R-Omop", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "k2", rule_id: "R-Omop", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "k3", rule_id: "R-Omop", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "n1", rule_id: "R-Note", anchored: true, origin: "note", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "n3", rule_id: "R-Note", anchored: true, origin: "note", verdict: "CONCORDANT" }, // b_only
      { patient_id: "p", event_id: "n4", rule_id: "R-Note", anchored: true, origin: "note", verdict: "CONCORDANT" }, // b_only
    ];
    const m = computePerEventMetrics(a, b);

    expect(m.enumeration.by_origin.omop).toEqual({ matched: 3, a_only: 1, b_only: 0, jaccard: 0.75 });
    expect(m.enumeration.by_origin.note).toEqual({ matched: 1, a_only: 1, b_only: 2, jaccard: 0.25 });

    expect(m.enumeration.matched).toBe(4);
    expect(m.enumeration.a_only).toBe(2);
    expect(m.enumeration.b_only).toBe(2);
    expect(m.enumeration.jaccard).toBeCloseTo(0.5);
  });
});

describe("computePerEventMetrics — data-integrity guards (priority test 8, minors)", () => {
  it("throws on a duplicate event_id within one side (never silently last-wins)", () => {
    const a: EventSide[] = [
      { patient_id: "p", event_id: "e1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "e1", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
    ];
    const b: EventSide[] = [
      { patient_id: "p", event_id: "e1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
    ];
    expect(() => computePerEventMetrics(a, b)).toThrow(/duplicate event_id/);
  });

  it("throws (does not A-wins-silently) when a matched key's two sides disagree on rule_id", () => {
    const a: EventSide[] = [{ patient_id: "p", event_id: "e1", rule_id: "R1", anchored: true, origin: "omop", verdict: "CONCORDANT" }];
    const b: EventSide[] = [{ patient_id: "p", event_id: "e1", rule_id: "R2", anchored: true, origin: "omop", verdict: "CONCORDANT" }];
    expect(() => computePerEventMetrics(a, b)).toThrow(/disagrees on rule_id/);
  });

  it("throws (does not A-wins-silently) when a matched key's two sides disagree on anchored", () => {
    const a: EventSide[] = [{ patient_id: "p", event_id: "e1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" }];
    const b: EventSide[] = [{ patient_id: "p", event_id: "e1", rule_id: "R", anchored: false, origin: "omop", verdict: "CONCORDANT" }];
    expect(() => computePerEventMetrics(a, b)).toThrow(/disagrees on anchored/);
  });

  it("throws (does not A-wins-silently) when a matched key's two sides disagree on origin (Important 3, Task 7 re-review)", () => {
    const a: EventSide[] = [{ patient_id: "p", event_id: "e1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" }];
    const b: EventSide[] = [{ patient_id: "p", event_id: "e1", rule_id: "R", anchored: true, origin: "note", verdict: "CONCORDANT" }];
    expect(() => computePerEventMetrics(a, b)).toThrow(/disagrees on origin/);
  });
});

describe("computePerEventMetrics — constant-rater degeneracy (Critical 2, Task 7 re-review)", () => {
  /** Builds n matched-anchored pairs where the gold (side b) is ALWAYS
   *  CONCORDANT and the agent (side a) agrees `nAgree` of the n times
   *  (disagreeing NON_CONCORDANT the rest) — i.e. a constant-marginal gold
   *  at a chosen raw agreement rate. */
  function constantGoldAtAgreement(n: number, nAgree: number): [EventSide[], EventSide[]] {
    const a: EventSide[] = [];
    const b: EventSide[] = [];
    for (let i = 0; i < n; i++) {
      a.push({
        patient_id: "p", event_id: `R@d@${i}`, rule_id: "R", anchored: true, origin: "omop",
        verdict: i < nAgree ? "CONCORDANT" : "NON_CONCORDANT",
      });
      b.push({ patient_id: "p", event_id: `R@d@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });
    }
    return [a, b];
  }

  it.each([
    { pct: "50%", nAgree: 50 },
    { pct: "90%", nAgree: 90 },
    { pct: "10%", nAgree: 10 },
    { pct: "99%", nAgree: 99 },
  ])("a constant-CONCORDANT gold at $pct raw agreement returns NaN + constant_rater_b, NOT 0", ({ nAgree }) => {
    const [a, b] = constantGoldAtAgreement(100, nAgree);
    const m = computePerEventMetrics(a, b);
    expect(m.verdict_n).toBe(100);
    expect(m.verdict_agreement).toBeCloseTo(nAgree / 100);
    expect(Number.isNaN(m.verdict_kappa)).toBe(true);
    expect(m.verdict_kappa_reason).toBe("constant_rater_b");
    // The old (broken) formula returned exactly 0 here regardless of nAgree
    // — pin that a real NaN+reason comes back instead, not a masked 0.
    expect(m.verdict_kappa).not.toBe(0);
  });

  it("a constant-CONCORDANT agent (side a) against a varying gold (side b) returns NaN + constant_rater_a — the mirror case", () => {
    const a: EventSide[] = [];
    const b: EventSide[] = [];
    for (let i = 0; i < 20; i++) {
      a.push({ patient_id: "p", event_id: `R@d@${i}`, rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" });
      b.push({
        patient_id: "p", event_id: `R@d@${i}`, rule_id: "R", anchored: true, origin: "omop",
        verdict: i < 18 ? "CONCORDANT" : "NON_CONCORDANT",
      });
    }
    const m = computePerEventMetrics(a, b);
    expect(m.verdict_n).toBe(20);
    expect(m.verdict_agreement).toBeCloseTo(0.9);
    expect(Number.isNaN(m.verdict_kappa)).toBe(true);
    expect(m.verdict_kappa_reason).toBe("constant_rater_a");
  });

  it("both raters constant but on DIFFERENT labels (100% disagreement, 0% union overlap) is also caught — not silently passed as 2-label variance", () => {
    const a: EventSide[] = [
      { patient_id: "p", event_id: "R@d@0", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "R@d@1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
    ];
    const b: EventSide[] = [
      { patient_id: "p", event_id: "R@d@0", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
      { patient_id: "p", event_id: "R@d@1", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
    ];
    const m = computePerEventMetrics(a, b);
    expect(Number.isNaN(m.verdict_kappa)).toBe(true);
    // a is checked before b — both are constant, a's check fires first.
    expect(m.verdict_kappa_reason).toBe("constant_rater_a");
  });

  it("once BOTH raters vary, kappa computes normally again (constant-rater guard doesn't over-fire)", () => {
    const a: EventSide[] = [
      { patient_id: "p", event_id: "R@d@0", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "R@d@1", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
      { patient_id: "p", event_id: "R@d@2", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "R@d@3", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
    ];
    const b: EventSide[] = [
      { patient_id: "p", event_id: "R@d@0", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "R@d@1", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
      { patient_id: "p", event_id: "R@d@2", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
      { patient_id: "p", event_id: "R@d@3", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
    ];
    const m = computePerEventMetrics(a, b);
    expect(m.verdict_kappa_reason).toBeUndefined();
    expect(Number.isFinite(m.verdict_kappa)).toBe(true);
  });
});

describe("computePerEventMetrics — one-sided NONE exclusion (Important 5, Task 7 re-review)", () => {
  it("dropping ONE side's verdict (not both) removes that pair from the scored population entirely — the same failure mode C2 fixed, surviving in a different branch", () => {
    // Baseline: both sides fully scored — 1/3 agree = 33.3%.
    const aFull: EventSide[] = [
      { patient_id: "p", event_id: "e1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "e2", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "e3", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
    ];
    const bFull: EventSide[] = [
      { patient_id: "p", event_id: "e1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT" },
      { patient_id: "p", event_id: "e2", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
      { patient_id: "p", event_id: "e3", rule_id: "R", anchored: true, origin: "omop", verdict: "NON_CONCORDANT" },
    ];
    const full = computePerEventMetrics(aFull, bFull);
    expect(full.verdict_n).toBe(3);
    expect(full.verdict_agreement).toBeCloseTo(1 / 3);

    // Incomplete: side B never reached e3 (still NONE) — side A DID reach
    // it (a real, committed CONCORDANT verdict). One-sided NONE, not a
    // NONE/NONE stub.
    const bIncomplete: EventSide[] = [
      bFull[0]!,
      bFull[1]!,
      { patient_id: "p", event_id: "e3", rule_id: "R", anchored: true, origin: "omop" }, // NONE
    ];
    const incomplete = computePerEventMetrics(aFull, bIncomplete);
    // e3 drops out of the scored population entirely — not counted as a
    // disagreement even though A already committed a real verdict there.
    // The incomplete pass (n=2, 50%) reads BETTER than the complete one
    // (n=3, 33.3%). This is documented (not fixed) behavior — the CLI's
    // completeness gate is what stands between this and a printed report.
    expect(incomplete.verdict_n).toBe(2);
    expect(incomplete.verdict_agreement).toBeCloseTo(0.5);
    expect(incomplete.n_unscored_b).toBe(1);
    expect(incomplete.n_unscored_a).toBe(0);
    expect(incomplete.completeness_a).toBe(1);
    expect(incomplete.completeness_b).toBeCloseTo(2 / 3);
  });
});
