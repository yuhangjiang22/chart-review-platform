import { describe, it, expect } from "vitest";
import { toolProfileFor, mcpAllowlist, STRUCTURED_DATA_TOOLS } from "./index.js";

describe("toolProfileFor", () => {
  it("notes-only phenotype: base tools, no structured, no plugins", () => {
    const p = toolProfileFor({ task_id: "x", task_kind: "phenotype" } as any);
    expect(p.baseTools).toContain("set_field_assessment");
    expect(p.structuredData).toBe(false);
    expect(p.pythonPlugins).toEqual([]);
    expect(mcpAllowlist(p)).not.toContain("list_structured_data");
  });

  it("phenotype with uses_structured_data adds the OMOP tools to the allowlist", () => {
    const p = toolProfileFor({ task_id: "x", task_kind: "phenotype", uses_structured_data: true } as any);
    expect(p.structuredData).toBe(true);
    expect(mcpAllowlist(p).split(",")).toEqual(expect.arrayContaining(STRUCTURED_DATA_TOOLS));
  });

  it("adherence profile exposes the question tools, not phenotype writes", () => {
    const p = toolProfileFor({ task_id: "asthma-adherence", task_kind: "adherence", uses_structured_data: true } as any);
    const allow = mcpAllowlist(p).split(",");
    expect(allow).toEqual(expect.arrayContaining(["list_questions", "set_question_answer"]));
    expect(allow).not.toContain("set_field_assessment");
  });

  it("a named tool_profile resolves to its registered entry (rucam → python plugins)", () => {
    const p = toolProfileFor({ task_id: "rucam", task_kind: "phenotype", tool_profile: "rucam", uses_structured_data: true } as any);
    expect(p.pythonPlugins.length).toBeGreaterThan(0);
    expect(p.dataSource).toBe("rucam-csv");
    // hybrid: still has the phenotype write surface (MCP), plus structured + plugins
    expect(p.baseTools).toContain("set_field_assessment");
  });

  it("the _demo profile loads the demo plugin (end-to-end proof hook)", () => {
    const p = toolProfileFor({ task_id: "x", task_kind: "phenotype", tool_profile: "_demo" } as any);
    expect(p.pythonPlugins).toContain("chart_review_plugins._demo");
    expect(p.baseTools).toContain("set_field_assessment"); // base surface intact
  });
});
