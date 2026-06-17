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

  it("phenotype allowlist exposes the section-extraction note tool (get_note_section)", () => {
    const p = toolProfileFor({ task_id: "cancer-diagnosis", task_kind: "phenotype" } as any);
    expect(p.baseTools).toContain("get_note_section");
    expect(mcpAllowlist(p).split(",")).toContain("get_note_section");
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

  it("rucam enables read_structured_data even without uses_structured_data (profile sets it)", () => {
    // The profile materializes labs/meds/conditions into omop/, so the agent can
    // cite CITABLE structured rows — the allowlist must expose the structured tools
    // regardless of the task's uses_structured_data flag.
    const p = toolProfileFor({ task_id: "rucam", task_kind: "phenotype", tool_profile: "rucam" } as any);
    expect(p.structuredData).toBe(true);
    expect(mcpAllowlist(p).split(",")).toEqual(expect.arrayContaining(STRUCTURED_DATA_TOOLS));
  });

  it("the _demo profile loads the demo plugin (end-to-end proof hook)", () => {
    const p = toolProfileFor({ task_id: "x", task_kind: "phenotype", tool_profile: "_demo" } as any);
    expect(p.pythonPlugins).toContain("chart_review_plugins._demo");
    expect(p.baseTools).toContain("set_field_assessment"); // base surface intact
  });
});

describe("rucam perItem", () => {
  const task = { task_id: "rucam", task_kind: "phenotype", tool_profile: "rucam" } as any;
  it("declares 7 ordered items with field_id, item_number, skill_file, keywords", () => {
    const p = toolProfileFor(task);
    expect(p.perItem).toBeDefined();
    expect(p.perItem!.map((e) => e.item_number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(p.perItem!.map((e) => e.field_id)).toEqual([
      "item_1_time_to_onset", "item_2_course", "item_3_risk_factors",
      "item_4_concomitant", "item_5_exclusion", "item_6_hepatotoxicity",
      "item_7_rechallenge",
    ]);
    const i5 = p.perItem!.find((e) => e.item_number === 5)!;
    expect(i5.skill_file).toContain("item-5-exclusion.md");
    expect(i5.keywords).toContain("autoimmune");
  });
  it("leaves perItem undefined for non-per-item tasks", () => {
    const cancer = { task_id: "cancer-diagnosis", task_kind: "phenotype" } as any;
    expect(toolProfileFor(cancer).perItem).toBeUndefined();
  });
});
