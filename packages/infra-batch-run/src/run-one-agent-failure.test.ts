import { describe, it, expect } from "vitest";
import { classifyAgentOutcome } from "./runs.js";

describe("classifyAgentOutcome", () => {
  it("fails when the agent emitted an error event", () => {
    expect(classifyAgentOutcome({ agentError: "APIConnectionError", writeCount: 0 }))
      .toEqual({ status: "error", error: "APIConnectionError" });
  });
  it("fails when the agent made zero set_field_assessment writes", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 0 }))
      .toEqual({ status: "error", error: "agent made no set_field_assessment writes this run" });
  });
  it("succeeds when the agent wrote at least one assessment and no error", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 2 }))
      .toEqual({ status: "ok" });
  });
  it("an error takes precedence even if some writes happened", () => {
    expect(classifyAgentOutcome({ agentError: "boom", writeCount: 1 }))
      .toEqual({ status: "error", error: "boom" });
  });
});
