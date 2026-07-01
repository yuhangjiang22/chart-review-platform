import { describe, it, expect } from "vitest";
import { describeTaskTools, TOOL_DESCRIPTIONS } from "./descriptions.js";
import type { CompiledTask } from "@chart-review/tasks";

const task = (over: Partial<CompiledTask> & { tool_profile?: string }): CompiledTask & { tool_profile?: string } =>
  ({ task_id: "t", ...over }) as CompiledTask & { tool_profile?: string };

const ids = (v: ReturnType<typeof describeTaskTools>, source: string) =>
  v.groups.filter((g) => g.source === source).flatMap((g) => g.tools.map((t) => t.id));

describe("describeTaskTools — per-task tool surface", () => {
  it("phenotype + structured: MCP write tools + OMOP read, no plugins", () => {
    const v = describeTaskTools(task({ task_kind: "phenotype", uses_structured_data: true }));
    expect(ids(v, "mcp")).toContain("set_field_assessment");
    expect(ids(v, "mcp")).toContain("search_notes");
    expect(ids(v, "structured")).toEqual(["list_structured_data", "read_structured_data"]);
    expect(v.groups.some((g) => g.source === "plugin")).toBe(false);
    // every listed tool carries a real description
    for (const g of v.groups) for (const t of g.tools) expect(t.description.length).toBeGreaterThan(3);
  });

  it("adherence: question tools, not the phenotype field-write", () => {
    const v = describeTaskTools(task({ task_kind: "adherence", uses_structured_data: true }));
    expect(ids(v, "mcp")).toContain("set_question_answer");
    expect(ids(v, "mcp")).not.toContain("set_field_assessment");
  });

  it("ner: exactly the 4 BSO-AD ontology tools, each described, no phenotype writes", () => {
    const v = describeTaskTools(task({ task_kind: "ner" }));
    expect(ids(v, "mcp")).toEqual([
      "list_entity_types", "get_concept_tree", "normalize_to_ontology", "locate_in_source",
    ]);
    expect(ids(v, "mcp")).not.toContain("set_field_assessment");
    for (const g of v.groups) for (const t of g.tools) expect(t.description).not.toBe("(no description)");
  });

  it("rucam profile: adds the rucam plugin tools + per-item count, structured on", () => {
    const v = describeTaskTools(task({ task_kind: "phenotype", tool_profile: "rucam" }));
    expect(ids(v, "plugin")).toContain("compute_r_ratio");
    expect(ids(v, "plugin")).toContain("score_item5_exclusion");
    expect(ids(v, "structured").length).toBe(2);   // rucam profile forces structuredData
    expect(v.per_item_count).toBe(7);
  });

  it("every base tool id has a description (no '(no description)')", () => {
    for (const id of Object.keys(TOOL_DESCRIPTIONS)) expect(TOOL_DESCRIPTIONS[id]).toBeTruthy();
    const v = describeTaskTools(task({ task_kind: "adherence", uses_structured_data: true }));
    for (const g of v.groups) for (const t of g.tools) expect(t.description).not.toBe("(no description)");
  });
});
