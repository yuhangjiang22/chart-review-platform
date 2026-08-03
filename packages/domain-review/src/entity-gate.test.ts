import { describe, it, expect } from "vitest";
import { assertAnswerEntities } from "./review-state.js";

const allergen = {
  id: "allergen",
  answer_schema: {
    type: "array",
    entity: {
      value_key: "Allergen",
      attributes: { Category: { enum: ["medication", "food", "environment", "biologic"] } },
    },
  },
};
const ent = (over: Record<string, unknown> = {}) => ({
  Allergen: "penicillin",
  Supporting_Evidence: "allergic to penicillin (rash)",
  ...over,
});

describe("assertAnswerEntities", () => {
  it("accepts a valid entity list (with optional enum attribute)", () => {
    expect(() => assertAnswerEntities(allergen, [ent()])).not.toThrow();
    expect(() => assertAnswerEntities(allergen, [ent({ Category: "medication" }), ent({ Allergen: "shellfish", Category: "food" })])).not.toThrow();
  });
  it("accepts [] (none documented / NKDA) and null/'' (not answered)", () => {
    expect(() => assertAnswerEntities(allergen, [])).not.toThrow();
    expect(() => assertAnswerEntities(allergen, null)).not.toThrow();
    expect(() => assertAnswerEntities(allergen, "")).not.toThrow();
  });
  it("rejects a non-array answer for an entity field", () => {
    expect(() => assertAnswerEntities(allergen, "penicillin; sulfa")).toThrow(/list of entity records|answer_not_array/);
  });
  it("rejects an entity missing the required value or Supporting_Evidence (agent write)", () => {
    expect(() => assertAnswerEntities(allergen, [{ Supporting_Evidence: "x" }])).toThrow(/missing required "Allergen"|entity_missing_value/);
    expect(() => assertAnswerEntities(allergen, [{ Allergen: "penicillin" }])).toThrow(/Supporting_Evidence|entity_missing_evidence/);
  });
  it("allows a reviewer (requireEvidence=false) to omit Supporting_Evidence, but still needs the value", () => {
    expect(() => assertAnswerEntities(allergen, [{ Allergen: "penicillin" }], false)).not.toThrow();
    expect(() => assertAnswerEntities(allergen, [{ Supporting_Evidence: "x" }], false)).toThrow(/entity_missing_value|missing required/);
  });
  it("rejects an off-enum attribute, accepts an absent one", () => {
    expect(() => assertAnswerEntities(allergen, [ent({ Category: "lunar" })])).toThrow(/not one of|entity_attr_off_enum/);
    expect(() => assertAnswerEntities(allergen, [ent({ Category: "" })])).not.toThrow(); // optional → absent ok
  });
  it("is a no-op for scalar fields", () => {
    expect(() => assertAnswerEntities({ id: "moca_score", answer_schema: { type: "integer" } }, 21)).not.toThrow();
    expect(() => assertAnswerEntities({ id: "x", answer_schema: { enum: ["1", "0"] } }, "1")).not.toThrow();
  });
});
