import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { classifyField, type ClassifyInput } from "../derived-adjudications/classifier";

const validJson = JSON.stringify({
  agent_1: {
    answer_match_human: false,
    evidence_overlap_jaccard: 0.2,
    notes_read_jaccard: 0.5,
    human_evidence_seen_by_agent: false,
    classification: "missed_human_evidence",
    rationale_short: "Agent 1 never opened note n7 which the reviewer cited.",
  },
  agent_2: {
    answer_match_human: true,
    evidence_overlap_jaccard: 0.9,
    notes_read_jaccard: 0.9,
    human_evidence_seen_by_agent: true,
    classification: "correct",
    rationale_short: "Match.",
  },
  pair: { classification: "one_wrong" },
  gap_signal: { candidate: false, reason: "single-patient signal", suggested_revision: null },
  trajectory_features: {
    notes_unique_to_agent_1: [],
    notes_unique_to_agent_2: ["n5"],
    notes_only_human_cited: ["n7"],
  },
});

const baseInput = (): ClassifyInput => ({
  patient_id: "p1",
  field_id: "C1",
  iter_id: "iter-1",
  field_prompt: "Was lung cancer confirmed?",
  human_assessment: { field_id: "C1", source: "reviewer", status: "approved", updated_at: "t", updated_by: "u" },
  human_comment: null,
  agent_1: {
    agent_id: "agent_1",
    assessment: { field_id: "C1", source: "agent", status: "agent_proposed", updated_at: "t", updated_by: "agent_1" },
    audit_text: "tool: read note n3\nassistant: I conclude no.",
  },
  agent_2: {
    agent_id: "agent_2",
    assessment: { field_id: "C1", source: "agent", status: "agent_proposed", updated_at: "t", updated_by: "agent_2" },
    audit_text: "tool: read note n7\nassistant: I conclude yes.",
  },
  guideline_text: "If pathology mentions adenocarcinoma → confirmed.",
});

beforeEach(() => {
  create.mockReset();
});

describe("classifyField", () => {
  it("returns a validated record on Haiku success", async () => {
    create.mockResolvedValueOnce({
      content: [{ type: "text", text: validJson }],
      usage: { input_tokens: 100, output_tokens: 200 },
      model: "claude-haiku-4-5",
    });
    const out = await classifyField(baseInput());
    expect(out.classifier.model).toBe("claude-haiku-4-5");
    expect(out.agent_1.classification).toBe("missed_human_evidence");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("falls back to Sonnet when Haiku output fails schema", async () => {
    create
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "{ not json" }],
        usage: { input_tokens: 100, output_tokens: 50 },
        model: "claude-haiku-4-5",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: validJson }],
        usage: { input_tokens: 100, output_tokens: 200 },
        model: "claude-sonnet-4-6",
      });
    const out = await classifyField(baseInput());
    expect(out.classifier.model).toBe("claude-sonnet-4-6");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("emits a degraded record (validation_failed) when both models fail", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 100, output_tokens: 5 },
      model: "claude-sonnet-4-6",
    });
    const out = await classifyField(baseInput());
    expect(out.agent_1.classification).toBe("validation_failed");
    expect(out.agent_2.classification).toBe("validation_failed");
  });
});
