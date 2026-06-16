import { describe, it, expect } from "vitest";
import { phenotypeToolset } from "./runs.js";

describe("phenotypeToolset — declarative tool scoping", () => {
  it("a notes-only task is NOT exposed the structured-data tools", () => {
    const tools = phenotypeToolset({}).split(",");
    expect(tools).toContain("list_notes");
    expect(tools).toContain("set_field_assessment");
    expect(tools).toContain("read_criteria");
    expect(tools).not.toContain("list_structured_data");
    expect(tools).not.toContain("read_structured_data");
  });

  it("a task that declares uses_structured_data gets the OMOP read tools", () => {
    const tools = phenotypeToolset({ uses_structured_data: true }).split(",");
    expect(tools).toContain("list_structured_data");
    expect(tools).toContain("read_structured_data");
    // still has the full base surface
    expect(tools).toContain("find_quote_offsets");
    expect(tools).toContain("set_review_status");
  });

  it("never exposes adherence-only tools (those are task_kind-gated in the server)", () => {
    const tools = phenotypeToolset({ uses_structured_data: true }).split(",");
    expect(tools).not.toContain("list_questions");
    expect(tools).not.toContain("set_question_answer");
  });
});
