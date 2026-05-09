import { describe, it, expect } from "vitest";
import { composeAgentOptions } from "../compose-agent";

describe("composeAgentOptions", () => {
  it("returns settingSources: ['project'] so .claude/skills/ is auto-discovered", () => {
    const opts = composeAgentOptions({ cwd: "/some/patient/dir" });
    expect(opts.settingSources).toEqual(["project"]);
  });

  it("includes Skill, Agent, and core file tools in allowedTools by default", () => {
    const opts = composeAgentOptions({ cwd: "/x" });
    expect(opts.allowedTools).toContain("Skill");
    expect(opts.allowedTools).toContain("Agent");
    expect(opts.allowedTools).toContain("Read");
    expect(opts.allowedTools).toContain("Glob");
    expect(opts.allowedTools).toContain("Grep");
  });

  it("appends extraTools to allowedTools", () => {
    const opts = composeAgentOptions({ cwd: "/x", extraTools: ["Write", "Bash"] });
    expect(opts.allowedTools).toContain("Write");
    expect(opts.allowedTools).toContain("Bash");
  });

  it("forwards cwd, mcpServers, and hooks unchanged", () => {
    const fakeMcp = { fake_server: { name: "x" } as unknown };
    const fakeHooks = { PreToolUse: [{ hooks: [() => ({})] }] };
    const opts = composeAgentOptions({
      cwd: "/foo",
      mcpServers: fakeMcp,
      hooks: fakeHooks,
    });
    expect(opts.cwd).toBe("/foo");
    expect(opts.mcpServers).toBe(fakeMcp);
    expect(opts.hooks).toBe(fakeHooks);
  });

  it("emits MCP-namespaced wildcard for each registered MCP server", () => {
    const opts = composeAgentOptions({
      cwd: "/x",
      mcpServers: { chart_review_state: {} as unknown, other_server: {} as unknown },
    });
    expect(opts.allowedTools).toContain("mcp__chart_review_state__*");
    expect(opts.allowedTools).toContain("mcp__other_server__*");
  });

  it("composes a small system prompt with patientId + taskId hints", () => {
    const opts = composeAgentOptions({
      cwd: "/x",
      patientId: "pt_42",
      taskId: "lung-cancer-phenotype",
    });
    const sp = String(opts.systemPrompt ?? "");
    expect(sp).toContain("pt_42");
    expect(sp).toContain("lung-cancer-phenotype");
    // Slim by design: comfortably under 800 chars (vs ~3000+ when protocol was prompt-stuffed)
    expect(sp.length).toBeLessThan(800);
  });

  it("surfaces guidelinePath when provided, alongside the taskId label", () => {
    const opts = composeAgentOptions({
      cwd: "/x",
      taskId: "lung-cancer-phenotype",
      guidelinePath: "/abs/path/to/guidelines/lung-cancer-phenotype",
    });
    const sp = String(opts.systemPrompt ?? "");
    expect(sp).toContain("lung-cancer-phenotype");
    expect(sp).toContain("/abs/path/to/guidelines/lung-cancer-phenotype");
  });

  it("appends extraSystemPrompt verbatim", () => {
    const opts = composeAgentOptions({
      cwd: "/x",
      extraSystemPrompt: "EXTRA_SECTION_MARKER",
    });
    expect(String(opts.systemPrompt ?? "")).toContain("EXTRA_SECTION_MARKER");
  });
});
