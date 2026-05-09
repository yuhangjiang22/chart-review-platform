import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListPilotIterations, mockSetPilotState, mockGetPilotManifest } = vi.hoisted(() => ({
  mockListPilotIterations: vi.fn(),
  mockSetPilotState: vi.fn(),
  mockGetPilotManifest: vi.fn(),
}));

vi.mock("../domain/iter/index.js", () => ({
  listPilotIterations: mockListPilotIterations,
  setPilotState: mockSetPilotState,
  getPilotManifest: mockGetPilotManifest,
}));

import { maybeTransitionIterToValidating } from "../domain/iter/pilots.js";

describe("maybeTransitionIterToValidating", () => {
  beforeEach(() => vi.clearAllMocks());

  it("transitions running iter to validating on first reviewer cell", () => {
    mockListPilotIterations.mockReturnValue([
      { iter_id: "iter_001", state: "running", task_id: "t1" },
    ]);
    maybeTransitionIterToValidating("t1", "patient_001", "field_A", 1);
    expect(mockSetPilotState).toHaveBeenCalledWith("t1", "iter_001", "validating");
  });

  it("does not double-transition an iter already in validating", () => {
    mockListPilotIterations.mockReturnValue([
      { iter_id: "iter_001", state: "validating", task_id: "t1" },
    ]);
    maybeTransitionIterToValidating("t1", "patient_001", "field_A", 2);
    expect(mockSetPilotState).not.toHaveBeenCalled();
  });

  it("does not transition when state is already complete", () => {
    mockListPilotIterations.mockReturnValue([
      { iter_id: "iter_001", state: "complete", task_id: "t1" },
    ]);
    maybeTransitionIterToValidating("t1", "patient_001", "field_A", 1);
    expect(mockSetPilotState).not.toHaveBeenCalled();
  });
});
