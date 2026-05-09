import { describe, it, expect } from "vitest";
import {
  isValidatingState,
  isRevisingState,
  isSupersededState,
  isLockedVersionState,
  type PilotState,
} from "../domain/iter/index.js";

describe("extended PilotState values", () => {
  it("accepts all eight values as PilotState", () => {
    const states: PilotState[] = [
      "running",
      "ready_to_validate",
      "complete",
      "abandoned",
      "validating",
      "revising",
      "superseded",
      "locked",
    ];
    expect(states).toHaveLength(8);
  });

  it("isValidatingState narrows correctly", () => {
    expect(isValidatingState("validating")).toBe(true);
    expect(isValidatingState("running")).toBe(false);
  });

  it("isRevisingState narrows correctly", () => {
    expect(isRevisingState("revising")).toBe(true);
    expect(isRevisingState("complete")).toBe(false);
  });

  it("isSupersededState narrows correctly", () => {
    expect(isSupersededState("superseded")).toBe(true);
    expect(isSupersededState("abandoned")).toBe(false);
  });

  it("isLockedVersionState narrows correctly", () => {
    expect(isLockedVersionState("locked")).toBe(true);
    expect(isLockedVersionState("complete")).toBe(false);
  });
});
