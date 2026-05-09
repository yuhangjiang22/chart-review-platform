import { describe, it, expect } from "vitest";
import { recomputeLiveAlerts } from "../live-alerts";

describe("recomputeLiveAlerts", () => {
  const task = {
    fields: [
      { id: "a" },
      { id: "b", is_applicable_when: "a == 'yes'" },
      { id: "outcome", derivation: "a == 'yes' AND b == 'yes' ? 'confirmed' : 'absent'" },
    ],
  };

  it("returns no alerts on a consistent state", () => {
    const state = {
      field_assessments: [
        { field_id: "a", answer: "yes", status: "approved" },
        { field_id: "b", answer: "yes", status: "approved" },
      ],
    };
    expect(recomputeLiveAlerts(task as never, state as never)).toEqual([]);
  });

  it("flags applicability_violation when b is set but gate is false", () => {
    const state = {
      field_assessments: [
        { field_id: "a", answer: "no", status: "approved" },
        { field_id: "b", answer: "yes", status: "approved" },
      ],
    };
    const out = recomputeLiveAlerts(task as never, state as never);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("applicability_violation");
    expect(out[0].fields).toContain("b");
  });

  it("flags derivation_violation when a derived field returns null", () => {
    const state = {
      field_assessments: [
        { field_id: "a", answer: "yes", status: "approved" },
        // b missing
      ],
    };
    const out = recomputeLiveAlerts(task as never, state as never);
    expect(out.some((a) => a.kind === "derivation_violation")).toBe(true);
  });
});
