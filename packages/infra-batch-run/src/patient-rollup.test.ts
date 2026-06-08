import { describe, it, expect } from "vitest";
import { rollupPatientStatus } from "./runs.js";

describe("rollupPatientStatus", () => {
  it("failed when every agent errored", () => {
    expect(rollupPatientStatus([{ status: "error" }, { status: "error" }])).toBe("failed");
  });
  it("complete_with_errors when some agents errored", () => {
    expect(rollupPatientStatus([{ status: "ok" }, { status: "error" }])).toBe("complete_with_errors");
  });
  it("complete when all agents succeeded", () => {
    expect(rollupPatientStatus([{ status: "ok" }, { status: "ok" }])).toBe("complete");
  });
  it("complete for a single ok agent", () => {
    expect(rollupPatientStatus([{ status: "ok" }])).toBe("complete");
  });
  it("failed for a single errored agent", () => {
    expect(rollupPatientStatus([{ status: "error" }])).toBe("failed");
  });
  // Empty-outcomes case: match light's behavior. light filters ok==0 → "failed".
  // No outcomes means no agent succeeded, so "failed" is the safe loud-fail.
  it("failed for empty outcomes (no agent succeeded)", () => {
    expect(rollupPatientStatus([])).toBe("failed");
  });
});
