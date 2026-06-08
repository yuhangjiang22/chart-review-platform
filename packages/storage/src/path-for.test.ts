import { describe, it, expect } from "vitest";
import { pathFor } from "./index.js";

describe("pathFor.reviewState", () => {
  it("scopes the path under the session id", () => {
    const p = pathFor.reviewState("sessionA", "patient_1", "lung-cancer");
    expect(p.endsWith("/var/reviews/sessionA/patient_1/lung-cancer/review_state.json")).toBe(true);
  });
});
