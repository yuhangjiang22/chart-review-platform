import { describe, it, expect } from "vitest";
import { computeEligibility, type IterSnapshot } from "../eligibility.js";

const passIter = (override_count = 1): IterSnapshot => ({
  iter_id: "iter_x",
  per_criterion: [
    { field_id: "f1", accuracy: 0.95, n_evaluable: 10, n_correct: 9 },
    { field_id: "f2", accuracy: 0.92, n_evaluable: 10, n_correct: 9 },
  ],
  override_count,
});

const failIter = (): IterSnapshot => ({
  iter_id: "iter_y",
  per_criterion: [
    { field_id: "f1", accuracy: 0.85, n_evaluable: 10, n_correct: 8 },
  ],
  override_count: 5,
});

describe("eligibility", () => {
  it("eligible when last two iters both pass and overrides didn't grow", () => {
    expect(computeEligibility([passIter(2), passIter(1)]).eligible).toBe(true);
  });
  it("not eligible with only one passing iter", () => {
    expect(computeEligibility([failIter(), passIter()]).eligible).toBe(false);
  });
  it("not eligible if override_count grew", () => {
    // oldest=1, newest=3: growth = +2 → not eligible
    expect(computeEligibility([passIter(1), passIter(3)]).eligible).toBe(false);
  });
  it("not eligible if any criterion < 0.9", () => {
    const last = passIter();
    last.per_criterion[0].accuracy = 0.85;
    expect(computeEligibility([passIter(), last]).eligible).toBe(false);
  });
  it("returns 1-of-2 progress when only the most recent passes", () => {
    const r = computeEligibility([failIter(), passIter()]);
    expect(r.consecutive_passing).toBe(1);
  });
});
