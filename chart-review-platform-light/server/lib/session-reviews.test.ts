import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the iter listing the helper reads. Must be declared before importing
// the module under test so the mock is in place at import time.
const listPilotIterations = vi.fn();
vi.mock("./domain/iter/index.js", () => ({ listPilotIterations: () => listPilotIterations() }));

import { sessionReviewsRoot, sessionIdForRun } from "./session-reviews.js";

beforeEach(() => vi.clearAllMocks());

describe("sessionReviewsRoot", () => {
  it("returns var/reviews/<sessionId>", () => {
    expect(sessionReviewsRoot("session9").endsWith("/var/reviews/session9")).toBe(true);
  });
});

describe("sessionIdForRun", () => {
  it("returns the session_id of the iter whose run_id matches", () => {
    listPilotIterations.mockReturnValue([
      { run_id: "run-a", session_id: "session-1" },
      { run_id: "run-b", session_id: "session-2" },
    ]);
    expect(sessionIdForRun("task", "run-b")).toBe("session-2");
  });

  it("returns null when no iter references the run", () => {
    listPilotIterations.mockReturnValue([{ run_id: "run-a", session_id: "session-1" }]);
    expect(sessionIdForRun("task", "missing")).toBeNull();
  });

  it("returns null when the matching iter has no session_id (legacy run)", () => {
    listPilotIterations.mockReturnValue([{ run_id: "run-a" }]);
    expect(sessionIdForRun("task", "run-a")).toBeNull();
  });
});
