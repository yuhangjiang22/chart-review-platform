import { describe, it, expect } from "vitest";
import { evalDerivation, type MinimalTask } from "./index.js";

// The derivation shipped on item_3_risk_factors.md — kept in sync with the rubric.
const ITEM3_DERIV =
  '(((rf_alcohol == "yes") OR (injury_track != "hepatocellular" AND rf_pregnancy == "yes")) ? 1 : 0) + ((rf_age_ge_55 == "yes") ? 1 : 0)';

const TASK: MinimalTask = {
  fields: [
    { id: "injury_track" },
    { id: "rf_alcohol" },
    { id: "rf_pregnancy" },
    { id: "rf_age_ge_55" },
    { id: "item_3_risk_factors", derivation: ITEM3_DERIV },
  ],
};

const score = (a: Record<string, unknown>) =>
  evalDerivation(TASK, a, "item_3_risk_factors");

describe("RUCAM item 3 derived from extracted sub-facts", () => {
  it("pregnancy does NOT count on the hepatocellular track", () => {
    expect(score({ injury_track: "hepatocellular", rf_alcohol: "no", rf_pregnancy: "yes", rf_age_ge_55: "no" })).toBe(0);
  });

  it("pregnancy DOES count on the cholestatic/mixed track", () => {
    expect(score({ injury_track: "cholestatic", rf_alcohol: "no", rf_pregnancy: "yes", rf_age_ge_55: "no" })).toBe(1);
    expect(score({ injury_track: "mixed", rf_alcohol: "no", rf_pregnancy: "yes", rf_age_ge_55: "no" })).toBe(1);
  });

  it("alcohol and age stack to 2", () => {
    expect(score({ injury_track: "hepatocellular", rf_alcohol: "yes", rf_pregnancy: "no", rf_age_ge_55: "yes" })).toBe(2);
  });

  it("alcohol alone → 1 on either track", () => {
    expect(score({ injury_track: "hepatocellular", rf_alcohol: "yes", rf_pregnancy: "no", rf_age_ge_55: "no" })).toBe(1);
  });

  it("no risk factors → 0", () => {
    expect(score({ injury_track: "mixed", rf_alcohol: "no", rf_pregnancy: "no", rf_age_ge_55: "no" })).toBe(0);
  });

  it("stays Pending (null) when any sub-fact is missing — never fabricated", () => {
    // rf_age_ge_55 absent
    expect(score({ injury_track: "mixed", rf_alcohol: "no", rf_pregnancy: "no" })).toBeNull();
    // injury_track absent
    expect(score({ rf_alcohol: "yes", rf_pregnancy: "no", rf_age_ge_55: "yes" })).toBeNull();
  });
});
