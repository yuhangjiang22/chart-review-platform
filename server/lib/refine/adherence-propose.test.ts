import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedPrompt = "";
let fakeResultText = "";
const runAgent = vi.fn(async function* (input: { prompt: string }) {
  capturedPrompt = input.prompt;
  yield { type: "result", result: fakeResultText, cost_usd: 0.004 } as const;
});

vi.mock("../agent-provider.js", () => ({ runAgent: (i: { prompt: string }) => runAgent(i) }));
vi.mock("@chart-review/model-config", () => ({ modelFor: (s: string) => (s === "judge" ? "claude-sonnet" : "claude-haiku") }));
vi.mock("@chart-review/patients", () => ({
  patientDir: (p: string) => `/tmp/p/${p}`,
  PLATFORM_ROOT: "/tmp/plat",
  isPhiPatient: () => false,
}));
vi.mock("@chart-review/rubric", () => ({ guidelineDir: (id: string) => `/tmp/skills/${id}` }));
vi.mock("@chart-review/tasks", () => ({ loadCompiledTask: () => ({ task_id: "asthma-adherence", task_kind: "adherence" }) }));
vi.mock("@chart-review/mcp-server-anthropic", () => ({ buildMcpServersConfig: () => ({ chart_review_state: {} }) }));

import {
  proposeAdherenceGuidanceEdit,
  buildAdherenceRefinerPrompt,
  scanAdherenceLeakage,
  type ProposeAdherenceEditInput,
} from "./adherence-propose.js";
import type { AdherenceRefinementExample } from "./adherence-candidates.js";

function ex(over: Partial<AdherenceRefinementExample> = {}): AdherenceRefinementExample {
  return {
    patient_id: "p1",
    agent_id: "agent_1",
    question_id: "T1-ACTScore",
    agent_answer: 22,
    reviewer_answer: 18,
    note_id: "n1",
    excerpt: "ACT 22 on 2024-01; ACT 18 on 2024-06 (most recent)",
    ...over,
  };
}
function input(over: Partial<ProposeAdherenceEditInput> = {}): ProposeAdherenceEditInput {
  return {
    taskId: "asthma-adherence",
    questionId: "T1-ACTScore",
    questionText: "What is the ACT score?",
    retrievalHints: "Look in pulmonology notes.",
    examples: [ex()],
    ...over,
  };
}
function wrap(o: unknown): string {
  return `pre\n<REFINE_PROPOSAL>\n${JSON.stringify(o)}\n</REFINE_PROPOSAL>\npost`;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedPrompt = "";
  fakeResultText = "";
});

describe("buildAdherenceRefinerPrompt", () => {
  it("inlines question + hints + the disagreement + the generalize instruction", () => {
    const p = buildAdherenceRefinerPrompt(input());
    expect(p).toContain("QUESTION refiner");
    expect(p).toContain("T1-ACTScore");
    expect(p).toContain("pulmonology notes");
    expect(p).toContain("agent → 22");
    expect(p).toContain("reviewer (correct) → 18");
    expect(p).toContain("GENERALIZE");
    expect(p).toContain("<REFINE_PROPOSAL>");
  });
});

describe("scanAdherenceLeakage", () => {
  it("flags a patient id", () => {
    expect(scanAdherenceLeakage("for patient p1 take 18", [ex()])).toMatch(/patient id/i);
  });
  it("flags a verbatim ≥40-char excerpt copy", () => {
    const longExcerpt = "the patient was last seen in clinic for asthma in late june of the year";
    expect(scanAdherenceLeakage(`Use the value where ${longExcerpt}.`, [ex({ excerpt: longExcerpt })])).toMatch(/verbatim/i);
  });
  it("passes a generalized rule", () => {
    expect(scanAdherenceLeakage("Use the MOST RECENT ACT score before the index date.", [ex()])).toBeNull();
  });
});

describe("proposeAdherenceGuidanceEdit", () => {
  it("returns the proposal on a well-formed sentinel", async () => {
    fakeResultText = wrap({
      gap_summary: "Doesn't say which ACT score when several exist.",
      proposed_guidance_addition: "When multiple ACT scores are documented, use the MOST RECENT before the index date.",
      rationale: "Generalizes the recency error across patients.",
    });
    const out = await proposeAdherenceGuidanceEdit(input());
    expect(out.ok).toBe(true);
    expect(out.proposal?.proposed_guidance_addition).toMatch(/most recent/i);
    expect(out.proposal?.leakage_warning).toBeUndefined();
    expect(capturedPrompt).toContain("QUESTION refiner");
  });

  it("fails on missing sentinel / schema / no examples", async () => {
    fakeResultText = "nope";
    expect((await proposeAdherenceGuidanceEdit(input())).error).toMatch(/sentinel/i);
    fakeResultText = wrap({ gap_summary: "x" });
    expect((await proposeAdherenceGuidanceEdit(input())).error).toMatch(/schema/i);
    expect((await proposeAdherenceGuidanceEdit(input({ examples: [] }))).error).toMatch(/no examples/i);
  });
});
