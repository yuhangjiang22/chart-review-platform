import { describe, it, expect } from "vitest";
import { buildImportedReviewState } from "./jobs-routes.js";

describe("buildImportedReviewState preserves encounters", () => {
  it("copies encounters + field_assessments (with encounter_id) from the draft", () => {
    const draft = {
      field_assessments: [
        { field_id: "apoe4", answer: "1", source: "agent", status: "agent_proposed", encounter_id: "n1" },
      ],
      encounters: [{ encounter_id: "n1", kind: "encounter", note_ids: ["n1"] }],
    };
    const out = buildImportedReviewState("p1", "chart-review-acts", "run_x", draft as never, ["agent"], "agent_drafted");
    expect(out.encounters).toEqual(draft.encounters);
    expect((out.field_assessments as Array<{ encounter_id?: string }>)[0]!.encounter_id).toBe("n1");
    expect(out.imported_from_run).toBe("run_x");
  });
  it("omits encounters when the draft has none", () => {
    const out = buildImportedReviewState("p1", "t", "r", { field_assessments: [] } as never, ["agent"], "agent_drafted");
    expect(out.encounters).toBeUndefined();
  });
});
