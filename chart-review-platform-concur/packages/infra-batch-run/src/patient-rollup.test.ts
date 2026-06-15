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
});
