import { describe, it, expect } from "vitest";
import { pathFor } from "./index.js";

describe("pathFor.reviewState", () => {
  it("scopes the path under the session id", () => {
    const p = pathFor.reviewState("session9", "patient_1", "cancer-diagnosis");
    expect(p.endsWith("/var/reviews/session9/patient_1/cancer-diagnosis/review_state.json")).toBe(true);
  });
});
