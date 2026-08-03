import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedPrompt = "";
let fakeResultText = "";
// The agent stream yields result OR error events; annotate the union so tests
// can inject an error-only generator via mockImplementationOnce.
type MockAgentEvent =
  | { type: "result"; result: string; cost_usd: number }
  | { type: "error"; error: string };
const runAgent = vi.fn(async function* (
  input: { prompt: string },
): AsyncGenerator<MockAgentEvent> {
  capturedPrompt = input.prompt;
  yield { type: "result", result: fakeResultText, cost_usd: 0.002 };
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
vi.mock("../criterion-md.js", () => ({ atomicWriteText: vi.fn() }));
vi.mock("../domain/iter/pilots.js", () => ({ pilotIterDir: (t: string, i: string) => `/tmp/pilots/${t}/${i}` }));
vi.mock("./adherence-candidates.js", () => ({ collectAdherenceRefinementCandidates: vi.fn() }));

import {
  analyzeAdherenceQuestion,
  buildAdherenceAnalyzerPrompt,
  type AnalyzeAdherenceInput,
} from "./adherence-error-analysis.js";
import type { AdherenceRefinementExample } from "./adherence-candidates.js";

function ex(over: Partial<AdherenceRefinementExample> = {}): AdherenceRefinementExample {
  return {
    patient_id: "p1",
    agent_id: "agent_1",
    question_id: "T1-ACTScore",
    agent_answer: 22,
    reviewer_answer: 18,
    note_id: "n1",
    excerpt: "ACT score documented as 18 on the most recent visit",
    ...over,
  };
}

function input(over: Partial<AnalyzeAdherenceInput> = {}): AnalyzeAdherenceInput {
  return {
    taskId: "asthma-adherence",
    questionId: "T1-ACTScore",
    questionText: "What is the most recent ACT score?",
    retrievalHints: "Look in pulmonology notes.",
    examples: [ex()],
    ...over,
  };
}

function wrap(o: unknown): string {
  return `pre\n<ERROR_ANALYSIS>\n${JSON.stringify(o)}\n</ERROR_ANALYSIS>\npost`;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedPrompt = "";
  fakeResultText = "";
});

describe("buildAdherenceAnalyzerPrompt", () => {
  it("inlines the question, retrieval hints, and the answer disagreement", () => {
    const p = buildAdherenceAnalyzerPrompt(input());
    expect(p).toContain("GROUND TRUTH");
    expect(p).toContain("T1-ACTScore");
    expect(p).toContain("most recent ACT score");
    expect(p).toContain("pulmonology notes"); // retrieval hints
    expect(p).toContain("agent → 22");
    expect(p).toContain("reviewer → 18");
    expect(p).toContain("<ERROR_ANALYSIS>");
  });

  it("handles a question with no retrieval hints", () => {
    const p = buildAdherenceAnalyzerPrompt(input({ retrievalHints: "" }));
    expect(p).toContain("(none)");
  });
});

describe("analyzeAdherenceQuestion", () => {
  it("returns the parsed analysis on a well-formed sentinel", async () => {
    fakeResultText = wrap({
      error_class: "rubric_gap",
      what_rubric_misses: "Doesn't say to take the MOST RECENT ACT when several are documented.",
      reasoning: "The agent picked an older score; the question never specifies recency.",
    });
    const out = await analyzeAdherenceQuestion(input());
    expect(out.ok).toBe(true);
    expect(out.analysis?.error_class).toBe("rubric_gap");
    expect(out.analysis?.what_rubric_misses).toMatch(/recent/i);
    expect(capturedPrompt).toContain("QUESTION error analyst");
  });

  it("classifies a model_slip", async () => {
    fakeResultText = wrap({ error_class: "model_slip", what_rubric_misses: "", reasoning: "Question is clear; agent misread." });
    expect((await analyzeAdherenceQuestion(input())).analysis?.error_class).toBe("model_slip");
  });

  it("fails cleanly with no examples / missing sentinel", async () => {
    expect((await analyzeAdherenceQuestion(input({ examples: [] }))).error).toMatch(/no examples/i);
    fakeResultText = "no sentinel";
    expect((await analyzeAdherenceQuestion(input())).error).toMatch(/sentinel/i);
  });

  it("surfaces a runAgent error", async () => {
    runAgent.mockImplementationOnce(async function* () {
      yield { type: "error", error: "boom" } as const;
    });
    expect((await analyzeAdherenceQuestion(input())).error).toMatch(/boom/);
  });
});
