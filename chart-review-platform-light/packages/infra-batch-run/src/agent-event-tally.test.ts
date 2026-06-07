import { describe, it, expect } from "vitest";
import { applyAgentEventToTally, classifyAgentOutcome } from "./runs.js";

// Regression: B1 originally counted set_field_assessment via the SDK PostToolUse
// hook, which the deepagents SUBPROCESS provider never fires — so every
// successful deepagents agent was misclassified as "no writes" → error → no
// draft. Counting from the AgentEvent stream (these exact shapes) fixes it.

const start = { agentError: null as string | null, writeCount: 0 };

function fold(events: Array<Record<string, unknown>>) {
  return events.reduce(
    (t, e) => applyAgentEventToTally(t, e as never),
    start,
  );
}

describe("applyAgentEventToTally", () => {
  it("counts set_field_assessment tool_use events from the stream (deepagents shape)", () => {
    const events = [
      { type: "tool_use", tool_name: "list_notes", tool_input: {} },
      { type: "tool_use", tool_name: "set_field_assessment", tool_input: { field_id: "cancer_type" } },
      { type: "tool_use", tool_name: "set_field_assessment", tool_input: { field_id: "disease_extent" } },
      { type: "tool_use", tool_name: "set_summary", tool_input: {} },
      { type: "result", result: "done" },
    ];
    const t = fold(events);
    expect(t.writeCount).toBe(2);
    expect(t.agentError).toBeNull();
    // A successful agent (>=1 write, no error) must NOT be failed.
    expect(classifyAgentOutcome(t)).toEqual({ status: "ok" });
  });

  it("captures an error event", () => {
    const t = fold([{ type: "error", error: "APIConnectionError: Connection error." }]);
    expect(t.agentError).toBe("APIConnectionError: Connection error.");
    expect(classifyAgentOutcome(t)).toEqual({ status: "error", error: "APIConnectionError: Connection error." });
  });

  it("a run with no set_field_assessment writes is classified error", () => {
    const t = fold([
      { type: "tool_use", tool_name: "list_notes", tool_input: {} },
      { type: "result", result: "done" },
    ]);
    expect(t.writeCount).toBe(0);
    expect(classifyAgentOutcome(t)).toEqual({
      status: "error",
      error: "agent made no set_field_assessment writes this run",
    });
  });

  it("does not mutate the input tally (pure fold)", () => {
    const base = { agentError: null as string | null, writeCount: 0 };
    applyAgentEventToTally(base, { type: "tool_use", tool_name: "set_field_assessment", tool_input: {} } as never);
    expect(base.writeCount).toBe(0);
  });
});
