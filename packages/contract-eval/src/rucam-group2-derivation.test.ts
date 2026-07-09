import { describe, it, expect } from "vitest";
import { evalDerivation, type MinimalTask } from "./index.js";

// group2_all_ruled_out is now DERIVED — "yes" only when all five per-cause Group II
// flags are "yes". Item 5's +2 tier (all Group I AND all Group II ruled out) depends
// on it, so the path is g2 flags → group2 gate → item_5. Kept in sync with the rubric.
const G1 = ["g1_hav_ruled_out", "g1_hbv_ruled_out", "g1_hcv_ruled_out", "g1_biliary_obstruction_ruled_out", "g1_alcoholism_ruled_out", "g1_ischemia_ruled_out"];
const G2 = ["g2_autoimmune_ruled_out", "g2_sepsis_ruled_out", "g2_chronic_hbv_hcv_ruled_out", "g2_pbc_psc_ruled_out", "g2_cmv_ebv_hsv_ruled_out"];
const N_GROUP1 = `count_true([${G1.join(", ")}])`;
const GROUP2 = `count_true([${G2.join(", ")}]) == 5 ? "yes" : "no"`;
const ITEM5 = 'alt_cause_explains == "yes" ? -3 : (n_group1_ruled_out >= 6 AND group2_all_ruled_out == "yes") ? 2 : n_group1_ruled_out >= 6 ? 1 : n_group1_ruled_out >= 4 ? 0 : -2';

const TASK: MinimalTask = {
  fields: [
    ...G1.map((id) => ({ id })), { id: "n_group1_ruled_out", derivation: N_GROUP1 },
    ...G2.map((id) => ({ id })), { id: "group2_all_ruled_out", derivation: GROUP2 },
    { id: "alt_cause_explains" },
    { id: "item_5_exclusion", derivation: ITEM5 },
  ],
};

const yesAll = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "yes"]));
/** first k of the 5 Group II flags "yes", rest "no". */
function g2(k: number): Record<string, string> {
  const o: Record<string, string> = {};
  G2.forEach((id, i) => { o[id] = i < k ? "yes" : "no"; });
  return o;
}

describe("RUCAM group2_all_ruled_out derived from 5 per-cause flags", () => {
  const gate = (a: Record<string, unknown>) => evalDerivation(TASK, a, "group2_all_ruled_out");
  it("'yes' only when all five are ruled out", () => {
    expect(gate(g2(5))).toBe("yes");
    expect(gate(g2(4))).toBe("no");
    expect(gate(g2(0))).toBe("no");
  });
  it("Pending (null) when any Group II cause is unassessed", () => {
    const partial: Record<string, unknown> = g2(5);
    delete partial.g2_pbc_psc_ruled_out;
    expect(gate(partial)).toBeNull();
  });
});

describe("Item 5 +2 tier requires all of Group I and Group II", () => {
  const item5 = (a: Record<string, unknown>) => evalDerivation(TASK, a, "item_5_exclusion");
  it("all 6 Group I + all 5 Group II → 2", () => {
    expect(item5({ ...yesAll(G1), ...g2(5), alt_cause_explains: "no" })).toBe(2);
  });
  it("all 6 Group I but Group II incomplete → 1", () => {
    expect(item5({ ...yesAll(G1), ...g2(4), alt_cause_explains: "no" })).toBe(1);
  });
  it("one unassessed Group II cause cascades to Pending", () => {
    const partial: Record<string, unknown> = { ...yesAll(G1), ...g2(5), alt_cause_explains: "no" };
    delete partial.g2_sepsis_ruled_out;
    expect(item5(partial)).toBeNull();
  });
});
