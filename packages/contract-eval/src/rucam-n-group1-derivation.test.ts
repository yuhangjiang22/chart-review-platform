import { describe, it, expect } from "vitest";
import { evalDerivation, type MinimalTask } from "./index.js";

// n_group1_ruled_out is now DERIVED — the count of the six per-cause Group I flags
// set to "yes". Item 5 consumes that count unchanged, so the whole path is
// flags → count → item_5 score. Kept in sync with the rubric.
const N_GROUP1 =
  "count_true([g1_hav_ruled_out, g1_hbv_ruled_out, g1_hcv_ruled_out, g1_biliary_obstruction_ruled_out, g1_alcoholism_ruled_out, g1_ischemia_ruled_out])";
const ITEM5 =
  'alt_cause_explains == "yes" ? -3 : (n_group1_ruled_out >= 6 AND group2_all_ruled_out == "yes") ? 2 : n_group1_ruled_out >= 6 ? 1 : n_group1_ruled_out >= 4 ? 0 : -2';

const FLAGS = [
  "g1_hav_ruled_out", "g1_hbv_ruled_out", "g1_hcv_ruled_out",
  "g1_biliary_obstruction_ruled_out", "g1_alcoholism_ruled_out", "g1_ischemia_ruled_out",
];

const TASK: MinimalTask = {
  fields: [
    ...FLAGS.map((id) => ({ id })),
    { id: "n_group1_ruled_out", derivation: N_GROUP1 },
    { id: "group2_all_ruled_out" },
    { id: "alt_cause_explains" },
    { id: "item_5_exclusion", derivation: ITEM5 },
  ],
};

/** first k flags "yes", the rest "no". */
function flags(k: number): Record<string, string> {
  const o: Record<string, string> = {};
  FLAGS.forEach((id, i) => { o[id] = i < k ? "yes" : "no"; });
  return o;
}

describe("RUCAM n_group1_ruled_out derived from 6 per-cause flags", () => {
  const count = (a: Record<string, unknown>) => evalDerivation(TASK, a, "n_group1_ruled_out");
  it("counts the 'yes' flags (0…6)", () => {
    expect(count(flags(0))).toBe(0);
    expect(count(flags(3))).toBe(3);
    expect(count(flags(6))).toBe(6);
  });
  it("counts a non-contiguous mix of yes/no", () => {
    expect(count({ ...flags(0), g1_hav_ruled_out: "yes", g1_hcv_ruled_out: "yes", g1_ischemia_ruled_out: "yes" })).toBe(3);
  });
  it("Pending (null) when any one cause is unassessed — never assumes ruled-out", () => {
    const partial: Record<string, unknown> = flags(6);
    delete partial.g1_hcv_ruled_out;
    expect(count(partial)).toBeNull();
  });
});

describe("Item 5 flows flags → count → score", () => {
  const item5 = (a: Record<string, unknown>) => evalDerivation(TASK, a, "item_5_exclusion");
  const g2no = { group2_all_ruled_out: "no", alt_cause_explains: "no" };
  it("all 6 Group I + all Group II ruled out → 2", () => {
    expect(item5({ ...flags(6), group2_all_ruled_out: "yes", alt_cause_explains: "no" })).toBe(2);
  });
  it("all 6 Group I only → 1", () => {
    expect(item5({ ...flags(6), ...g2no })).toBe(1);
  });
  it("4–5 ruled out → 0", () => {
    expect(item5({ ...flags(5), ...g2no })).toBe(0);
    expect(item5({ ...flags(4), ...g2no })).toBe(0);
  });
  it("fewer than 4 → -2", () => {
    expect(item5({ ...flags(3), ...g2no })).toBe(-2);
  });
  it("a clear alternative cause overrides to -3", () => {
    expect(item5({ ...flags(6), group2_all_ruled_out: "yes", alt_cause_explains: "yes" })).toBe(-3);
  });
  it("one unassessed cause cascades to a Pending Item 5", () => {
    const partial: Record<string, unknown> = { ...flags(6), ...g2no };
    delete partial.g1_alcoholism_ruled_out;
    expect(item5(partial)).toBeNull();
  });
});
