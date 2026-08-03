import { describe, it, expect } from "vitest";

// The manifest spread is `...(opts.per_note ? { per_note: true } : {})`.
// Verify that exact spread logic in isolation (mirrors runs.ts line ~705).
function spreadPerNote(opts: { per_note?: boolean }): Record<string, unknown> {
  return { ...(opts.per_note ? { per_note: true } : {}) };
}

describe("run manifest per_note spread", () => {
  it("includes per_note when true", () => {
    expect(spreadPerNote({ per_note: true })).toEqual({ per_note: true });
  });
  it("omits per_note when false/absent", () => {
    expect(spreadPerNote({})).toEqual({});
    expect(spreadPerNote({ per_note: false })).toEqual({});
  });
});
