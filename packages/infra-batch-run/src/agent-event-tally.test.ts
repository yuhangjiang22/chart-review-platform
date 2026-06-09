import { describe, it, expect } from "vitest";
import { applyAgentEventToTally, classifyAgentOutcome, type AgentTally } from "./runs.js";
import type { AgentEvent } from "@chart-review/agent-provider";
import type { TaskKind } from "@chart-review/tasks";

// Regression / generalization of the light "loud-fail" lesson: writes are
// counted from the provider-agnostic AgentEvent stream (type === "tool_use"),
// NOT the SDK PostToolUse hook — because the codex subprocess provider never
// fires JS hooks. v2 generalizes across 3 task kinds, each with its own
// primary write tool, plus a special "0 writes is OK if a completion signal
// was seen" rule for NER.

const start: AgentTally = { agentError: null, writeCount: 0, sawCompletion: false };

function fold(events: AgentEvent[], kind: TaskKind): AgentTally {
  return events.reduce((t, e) => applyAgentEventToTally(t, e, kind), start);
}

// The REAL provider shape: both the Claude Agent SDK and the codex provider
// emit MCP tool calls prefixed `mcp__<server>__<tool>` (codex can double it).
// The original tally matched only the bare name, so it counted 0 writes and
// wrongly failed every phenotype/adherence run on claude/codex. These pin the
// prefix-normalized match (verified against a real codex adherence transcript:
// `mcp__chart_review_adherence__set_question_answer`).
describe("applyAgentEventToTally — MCP-prefixed tool names (real provider shape)", () => {
  it("counts a codex/Claude MCP-prefixed adherence write", () => {
    const t = fold([
      { type: "tool_use", tool_name: "mcp__chart_review_adherence__list_questions", tool_input: {} },
      { type: "tool_use", tool_name: "mcp__chart_review_adherence__set_question_answer", tool_input: { question_id: "q1" } },
      { type: "tool_use", tool_name: "mcp__chart_review_adherence__set_question_answer", tool_input: { question_id: "q2" } },
      { type: "tool_use", tool_name: "mcp__chart_review_adherence__set_review_status", tool_input: { status: "complete" } },
    ], "adherence");
    expect(t.writeCount).toBe(2);
    expect(t.sawCompletion).toBe(true);
    expect(classifyAgentOutcome(t, "adherence")).toEqual({ status: "ok" });
  });

  it("counts an MCP-prefixed phenotype write", () => {
    const t = fold([
      { type: "tool_use", tool_name: "mcp__chart_review_state__set_field_assessment", tool_input: { field_id: "cancer_type" } },
    ], "phenotype");
    expect(t.writeCount).toBe(1);
    expect(classifyAgentOutcome(t, "phenotype")).toEqual({ status: "ok" });
  });

  it("counts an MCP-prefixed NER write and tolerates a doubled prefix", () => {
    const t = fold([
      { type: "tool_use", tool_name: "mcp__chart_review_ner__set_span_label", tool_input: {} },
      { type: "tool_use", tool_name: "mcp__mcp__chart_review_ner____set_review_status", tool_input: {} },
    ], "ner");
    expect(t.writeCount).toBe(1);
    expect(t.sawCompletion).toBe(true);
  });

  it("still ignores a prefixed non-write tool", () => {
    const t = fold([
      { type: "tool_use", tool_name: "mcp__codex__list_mcp_resources", tool_input: {} },
    ], "adherence");
    expect(t.writeCount).toBe(0);
    expect(t.sawCompletion).toBe(false);
  });
});

describe("applyAgentEventToTally", () => {
  it("counts the kind's primary write tool (phenotype: set_field_assessment)", () => {
    const events: AgentEvent[] = [
      { type: "tool_use", tool_name: "list_notes", tool_input: {} },
      { type: "tool_use", tool_name: "set_field_assessment", tool_input: { field_id: "cancer_type" } },
      { type: "tool_use", tool_name: "set_field_assessment", tool_input: { field_id: "disease_extent" } },
      { type: "result", result: "done" },
    ];
    const t = fold(events, "phenotype");
    expect(t.writeCount).toBe(2);
    expect(t.agentError).toBeNull();
    expect(t.sawCompletion).toBe(true);
  });

  it("counts the kind's primary write tool (adherence: set_question_answer)", () => {
    const events: AgentEvent[] = [
      { type: "tool_use", tool_name: "set_question_answer", tool_input: { question_id: "q1" } },
      { type: "tool_use", tool_name: "set_question_answer", tool_input: { question_id: "q2" } },
      { type: "tool_use", tool_name: "set_review_status", tool_input: { status: "complete" } },
    ];
    const t = fold(events, "adherence");
    expect(t.writeCount).toBe(2);
    expect(t.sawCompletion).toBe(true);
  });

  it("counts the kind's primary write tool (ner: set_span_label)", () => {
    const events: AgentEvent[] = [
      { type: "tool_use", tool_name: "set_span_label", tool_input: { concept_name: "x" } },
      { type: "result", result: "done" },
    ];
    const t = fold(events, "ner");
    expect(t.writeCount).toBe(1);
    expect(t.sawCompletion).toBe(true);
  });

  it("does NOT count another kind's write tool for this kind", () => {
    // set_question_answer / set_span_label must not increment a phenotype run.
    const events: AgentEvent[] = [
      { type: "tool_use", tool_name: "set_question_answer", tool_input: {} },
      { type: "tool_use", tool_name: "set_span_label", tool_input: {} },
      { type: "result", result: "done" },
    ];
    const t = fold(events, "phenotype");
    expect(t.writeCount).toBe(0);
  });

  it("does NOT count set_field_assessment for an adherence run", () => {
    const events: AgentEvent[] = [
      { type: "tool_use", tool_name: "set_field_assessment", tool_input: {} },
      { type: "result", result: "done" },
    ];
    expect(fold(events, "adherence").writeCount).toBe(0);
  });

  it("does NOT count set_field_assessment for a ner run", () => {
    const events: AgentEvent[] = [
      { type: "tool_use", tool_name: "set_field_assessment", tool_input: {} },
      { type: "result", result: "done" },
    ];
    expect(fold(events, "ner").writeCount).toBe(0);
  });

  it("a result event sets sawCompletion", () => {
    const t = fold([{ type: "result", result: "done" }], "phenotype");
    expect(t.sawCompletion).toBe(true);
  });

  it("a set_review_status tool_use sets sawCompletion (even without a result event)", () => {
    const t = fold(
      [{ type: "tool_use", tool_name: "set_review_status", tool_input: { status: "complete" } }],
      "ner",
    );
    expect(t.sawCompletion).toBe(true);
  });

  it("captures an error event", () => {
    const t = fold([{ type: "error", error: "APIConnectionError: Connection error." }], "phenotype");
    expect(t.agentError).toBe("APIConnectionError: Connection error.");
  });

  it("falls back to a generic message when an error event carries no message", () => {
    const t = applyAgentEventToTally(start, { type: "error", error: "" }, "phenotype");
    expect(t.agentError).toBe("agent error");
  });

  it("ignores unrelated event types (text, tool_result)", () => {
    const events: AgentEvent[] = [
      { type: "text", text: "thinking" },
      { type: "tool_result", output: "ok" },
    ];
    const t = fold(events, "phenotype");
    expect(t).toEqual(start);
  });

  it("does not mutate the input tally (pure fold)", () => {
    const base: AgentTally = { agentError: null, writeCount: 0, sawCompletion: false };
    applyAgentEventToTally(
      base,
      { type: "tool_use", tool_name: "set_field_assessment", tool_input: {} },
      "phenotype",
    );
    expect(base).toEqual({ agentError: null, writeCount: 0, sawCompletion: false });
  });
});

describe("classifyAgentOutcome — phenotype", () => {
  it("0 writes → error", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 0, sawCompletion: true }, "phenotype"))
      .toEqual({ status: "error", error: "agent made no set_field_assessment writes this run" });
  });
  it(">=1 write → ok", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 3, sawCompletion: true }, "phenotype"))
      .toEqual({ status: "ok" });
  });
  it("error event → error even with writes", () => {
    expect(classifyAgentOutcome({ agentError: "boom", writeCount: 5, sawCompletion: true }, "phenotype"))
      .toEqual({ status: "error", error: "boom" });
  });
});

describe("classifyAgentOutcome — adherence", () => {
  it("0 writes → error", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 0, sawCompletion: true }, "adherence"))
      .toEqual({ status: "error", error: "agent made no set_question_answer writes this run" });
  });
  it(">=1 write → ok", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 1, sawCompletion: true }, "adherence"))
      .toEqual({ status: "ok" });
  });
  it("error event → error even with writes", () => {
    expect(classifyAgentOutcome({ agentError: "boom", writeCount: 5, sawCompletion: true }, "adherence"))
      .toEqual({ status: "error", error: "boom" });
  });
});

describe("classifyAgentOutcome — ner", () => {
  it("0 spans + completion signal → ok (a note with no entities is valid)", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 0, sawCompletion: true }, "ner"))
      .toEqual({ status: "ok" });
  });
  it("0 spans + NO completion signal → error (agent died/hung before signalling done)", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 0, sawCompletion: false }, "ner"))
      .toEqual({ status: "error", error: "NER agent produced no completion signal this run" });
  });
  it(">=1 span + completion → ok", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 4, sawCompletion: true }, "ner"))
      .toEqual({ status: "ok" });
  });
  it("error event → error (even with spans + completion)", () => {
    expect(classifyAgentOutcome({ agentError: "boom", writeCount: 4, sawCompletion: true }, "ner"))
      .toEqual({ status: "error", error: "boom" });
  });
});
