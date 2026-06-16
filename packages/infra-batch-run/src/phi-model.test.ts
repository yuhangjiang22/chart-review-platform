import { describe, it, expect } from "vitest";
import { resolveAgentModel } from "./runs.js";

describe("resolveAgentModel — PHI routing", () => {
  it("non-PHI patient uses the spec model", () => {
    expect(resolveAgentModel(false, "gpt-4o", "qwen3-32b")).toBe("qwen3-32b");
  });

  it("PHI patient uses the configured PHI model, not the spec model", () => {
    expect(resolveAgentModel(true, "gpt-4o", "qwen3-32b")).toBe("gpt-4o");
  });

  it("PHI patient with no PHI model throws (loud-fail — never leak PHI to the default)", () => {
    expect(() => resolveAgentModel(true, undefined, "qwen3-32b")).toThrow(/PHI/);
    expect(() => resolveAgentModel(true, undefined, "anything")).toThrow(/CHART_REVIEW_PHI_MODEL/);
  });
});
