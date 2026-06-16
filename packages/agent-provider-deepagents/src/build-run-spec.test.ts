// packages/agent-provider-deepagents/src/build-run-spec.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildRunSpec, nextRunSpecPath } from "./index.js";

const base = {
  prompt: "hi",
  mcpServers: { chart_review_state: { command: "x", args: [], env: {} } },
} as any;

describe("buildRunSpec", () => {
  it("includes model when input.model is set", () => {
    const spec = buildRunSpec({ ...base, model: "llama-3.3-70b" });
    expect(spec).not.toBeNull();
    expect(spec!.model).toBe("llama-3.3-70b");
  });
  it("omits model when input.model is absent", () => {
    const spec = buildRunSpec(base);
    expect(spec).not.toBeNull();
    expect(spec!.model).toBeUndefined();
  });
  it("carries prompt, system prompt, max_turns, mcp", () => {
    const spec = buildRunSpec({ ...base, extraSystemPrompt: "sys", maxTurns: 12 });
    expect(spec).not.toBeNull();
    expect(spec!.prompt).toBe("hi");
    expect(spec!.system_prompt).toBe("sys");
    expect(spec!.max_turns).toBe(12);
    expect(spec!.mcp).toEqual(base.mcpServers.chart_review_state);
  });
  it("returns null when no chart_review_state MCP config", () => {
    const spec = buildRunSpec({ prompt: "hi" } as any);
    expect(spec).toBeNull();
  });
  it("carries python_plugins + data_dir + plugin_bind + skills when provided", () => {
    const spec = buildRunSpec({ ...base, pythonPlugins: ["chart_review_plugins.rucam"], dataDir: "/x", pluginBind: { person_id: 9001 }, skills: ["/chart-review-rucam/"] });
    expect(spec!.python_plugins).toEqual(["chart_review_plugins.rucam"]);
    expect(spec!.data_dir).toBe("/x");
    expect(spec!.plugin_bind).toEqual({ person_id: 9001 });
    expect(spec!.skills).toEqual(["/chart-review-rucam/"]);
  });
  it("omits python_plugins/data_dir/plugin_bind/skills when absent", () => {
    const spec = buildRunSpec(base);
    expect(spec!.python_plugins).toBeUndefined();
    expect(spec!.data_dir).toBeUndefined();
    expect(spec!.plugin_bind).toBeUndefined();
    expect(spec!.skills).toBeUndefined();
  });
});

describe("nextRunSpecPath — concurrency safety", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a UNIQUE path even when two calls land in the same millisecond", () => {
    // Pin Date.now() to a constant so both calls share the timestamp segment —
    // the exact collision that made concurrent agents clobber each other's
    // runspec and cross patient context.
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const a = nextRunSpecPath();
    const b = nextRunSpecPath();
    expect(a).not.toBe(b); // the monotonic counter disambiguates
  });

  it("generates distinct paths across many rapid calls", () => {
    vi.spyOn(Date, "now").mockReturnValue(42);
    const paths = new Set(Array.from({ length: 50 }, () => nextRunSpecPath()));
    expect(paths.size).toBe(50);
  });
});
