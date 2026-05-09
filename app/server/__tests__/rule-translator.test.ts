import { describe, it, expect, vi, beforeEach } from "vitest";
import { translateRule, TranslateInput } from "../domain/proposal/index.js";
import type { CompiledTask } from "../domain/rubric/index.js";

vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn(() => ({ messages: { create: mockCreate } })),
    __mockCreate: mockCreate,
  };
});

const sdk = (await import("@anthropic-ai/sdk")) as unknown as { __mockCreate: ReturnType<typeof vi.fn> };

const fixtureBundle: CompiledTask = {
  task_id: "t1",
  fields: [
    { id: "pathology_report_present", prompt: "Q1", answer_schema: { enum: [true, false] } },
    { id: "cytology_supports_lung_primary", prompt: "Q2", is_applicable_when: "pathology_report_present == 'no'" },
  ],
};

const baseInput: TranslateInput = {
  bundle: fixtureBundle,
  nl_rule: "don't count cytology unless surgical path is missing",
};

beforeEach(() => sdk.__mockCreate.mockReset());

describe("translateRule — gate edit happy path", () => {
  it("returns the proposed edit when SDK succeeds", async () => {
    sdk.__mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", name: "propose_edit", input: {
        field_id: "cytology_supports_lung_primary",
        edit_type: "is_applicable_when_replace",
        payload: "pathology_report_present == 'no' AND surgical_pathology_present == 'no'",
        rationale: "Reviewer judges cytology insufficient when surgical path is available.",
      }}],
    });
    const result = await translateRule(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edit.field_id).toBe("cytology_supports_lung_primary");
      expect(result.edit.edit_type).toBe("is_applicable_when_replace");
    }
  });
});

describe("translateRule — DSL parse failure", () => {
  it("returns error when DSL doesn't parse", async () => {
    sdk.__mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", name: "propose_edit", input: {
        field_id: "cytology_supports_lung_primary",
        edit_type: "is_applicable_when_replace",
        payload: "garbage ^^^ syntax",
        rationale: "...",
      }}],
    });
    const result = await translateRule(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/dsl|parse|illegal/i);
  });
});

describe("translateRule — translator self-flagged one-off", () => {
  it("surfaces translator's `one_off_no_pattern` error", async () => {
    sdk.__mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", name: "propose_edit", input: {
        field_id: "cytology_supports_lung_primary",
        edit_type: "is_applicable_when_replace",
        payload: "ERROR: one_off_no_pattern",
        rationale: "Override appears case-specific; reviewer should refine.",
      }}],
    });
    const result = await translateRule(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/one.off|pattern/i);
  });
});

describe("translateRule — prose edit path skips DSL validation", () => {
  it("returns prose edit without DSL parse step", async () => {
    sdk.__mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", name: "propose_edit", input: {
        field_id: "cytology_supports_lung_primary",
        edit_type: "guidance_prose_append",
        payload: "Cytology should generally not confirm primary when surgical path is unavailable.",
        rationale: "Adds soft reasoning to existing definition.",
      }}],
    });
    const result = await translateRule(baseInput);
    expect(result.ok).toBe(true);
  });
});
