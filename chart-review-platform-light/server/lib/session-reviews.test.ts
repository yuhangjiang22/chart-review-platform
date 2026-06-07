import { describe, it, expect } from "vitest";
import { sessionReviewsRoot } from "./session-reviews.js";

describe("sessionReviewsRoot", () => {
  it("returns var/reviews/<sessionId>", () => {
    expect(sessionReviewsRoot("session9").endsWith("/var/reviews/session9")).toBe(true);
  });
});
