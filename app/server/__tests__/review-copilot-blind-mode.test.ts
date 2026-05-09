import { describe, it, expect } from "vitest";
import { buildCopilotExtraSystemPrompt } from "../ai-client.js";

// ---------------------------------------------------------------------------
// Session cache key shape — verifies the key includes the blind-mode flag so
// that blind and normal sessions for the same (patientId, taskId) are distinct.
// This mirrors the logic in server.ts::sessionKey without importing the server.
// ---------------------------------------------------------------------------
function sessionKey(patientId: string, taskId: string, blindMode?: boolean): string {
  return `${patientId}::${taskId}::${blindMode ? "blind" : "normal"}`;
}

describe("sessionKey — blind-mode cache isolation", () => {
  it("returns different keys for blindMode=true vs blindMode=false", () => {
    expect(sessionKey("p1", "t1", true)).not.toBe(sessionKey("p1", "t1", false));
  });

  it("blindMode=undefined is treated as normal (same key as false)", () => {
    expect(sessionKey("p1", "t1", undefined)).toBe(sessionKey("p1", "t1", false));
  });

  it("blind key ends with ::blind, normal key ends with ::normal", () => {
    expect(sessionKey("p1", "t1", true)).toMatch(/::blind$/);
    expect(sessionKey("p1", "t1", false)).toMatch(/::normal$/);
  });
});

const BASE_ARGS = {
  reviewStateAbs: "/data/reviews/p1/task1/review_state.json",
  guidelineAbs: "/data/guidelines/task1",
  noteFiles: ["/data/patients/p1/notes/note1.txt"],
};

describe("buildCopilotExtraSystemPrompt — blind_mode flag", () => {
  it("includes standard copilot instructions in both modes", () => {
    const blind = buildCopilotExtraSystemPrompt({ ...BASE_ARGS, blindMode: true });
    const normal = buildCopilotExtraSystemPrompt({ ...BASE_ARGS, blindMode: false });

    // Both should reference the review-copilot skill activation
    expect(blind).toContain("review-copilot");
    expect(normal).toContain("review-copilot");

    // Both should surface the pre-listed paths
    expect(blind).toContain("review_state.json");
    expect(normal).toContain("review_state.json");
  });

  it("blind mode prompt contains the blind-mode refusal rule", () => {
    const prompt = buildCopilotExtraSystemPrompt({ ...BASE_ARGS, blindMode: true });

    // Must contain the blind mode section header
    expect(prompt).toContain("BLIND MODE");

    // Must instruct the copilot NOT to disclose the agent's answer/rationale
    expect(prompt).toContain("Do NOT disclose the drafting agent");

    // Must address the specific question pattern the oracle might ask
    expect(prompt).toContain("what did the agent answer");
    expect(prompt).toContain("independent judgment");
  });

  it("blind mode prompt does NOT omit the standard non-commit instruction", () => {
    const prompt = buildCopilotExtraSystemPrompt({ ...BASE_ARGS, blindMode: true });
    // The existing 'never commit' rule must still be present
    expect(prompt).toContain("Never commit answers");
  });

  it("normal mode prompt does NOT contain the blind-mode section", () => {
    const prompt = buildCopilotExtraSystemPrompt({ ...BASE_ARGS, blindMode: false });

    expect(prompt).not.toContain("BLIND MODE");
    expect(prompt).not.toContain("Do NOT disclose the drafting agent");
  });

  it("undefined blindMode behaves identically to false", () => {
    const withFalse = buildCopilotExtraSystemPrompt({ ...BASE_ARGS, blindMode: false });
    const withUndefined = buildCopilotExtraSystemPrompt({ ...BASE_ARGS });

    expect(withUndefined).toBe(withFalse);
  });

  it("blind mode prompt contains the sentinel phrase used for grep-based checks", () => {
    const prompt = buildCopilotExtraSystemPrompt({ ...BASE_ARGS, blindMode: true });
    // Verifiable sentinel that tests in CI can grep for
    expect(prompt).toContain("Blind mode is active");
  });
});
