// packages/agent-provider-deepagents/src/build-run-spec.test.ts
import { describe, it, expect } from "vitest";
import { buildRunSpec } from "./index.js";

const base = {
  prompt: "hi",
  mcpServers: { chart_review_state: { command: "x", args: [], env: {} } },
} as any;

describe("buildRunSpec", () => {
  it("includes model when input.model is set", () => {
    const spec = buildRunSpec({ ...base, model: "llama-3.3-70b" });
    expect(spec!.model).toBe("llama-3.3-70b");
  });
  it("omits model when input.model is absent", () => {
    const spec = buildRunSpec(base);
    expect(spec!.model).toBeUndefined();
  });
  it("carries prompt, system prompt, max_turns, mcp", () => {
    const spec = buildRunSpec({ ...base, extraSystemPrompt: "sys", maxTurns: 12 });
    expect(spec!.prompt).toBe("hi");
    expect(spec!.system_prompt).toBe("sys");
    expect(spec!.max_turns).toBe(12);
    expect(spec!.mcp).toEqual(base.mcpServers.chart_review_state);
  });
  it("returns null when no chart_review_state MCP config", () => {
    const spec = buildRunSpec({ prompt: "hi" } as any);
    expect(spec).toBeNull();
  });
});
