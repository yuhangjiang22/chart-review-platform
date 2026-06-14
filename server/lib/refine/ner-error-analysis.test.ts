import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedPrompt = "";
let fakeResultText = "";
const runAgent = vi.fn(async function* (input: { prompt: string }) {
  capturedPrompt = input.prompt;
  yield { type: "result", result: fakeResultText, cost_usd: 0.003 } as const;
});

vi.mock("../agent-provider.js", () => ({ runAgent: (i: { prompt: string }) => runAgent(i) }));
vi.mock("@chart-review/model-config", () => ({ modelFor: (s: string) => (s === "judge" ? "claude-sonnet" : "claude-haiku") }));
vi.mock("@chart-review/patients", () => ({
  patientDir: (p: string) => `/tmp/p/${p}`,
  PLATFORM_ROOT: "/tmp/plat",
  isPhiPatient: () => false,
}));
vi.mock("@chart-review/rubric", () => ({ guidelineDir: (id: string) => `/tmp/skills/${id}` }));
vi.mock("@chart-review/tasks", () => ({ loadCompiledTask: () => ({ task_id: "bso-ad-ner", task_kind: "ner" }) }));
vi.mock("@chart-review/mcp-server-anthropic", () => ({ buildMcpServersConfig: () => ({ chart_review_state: {} }) }));
vi.mock("../criterion-md.js", () => ({ atomicWriteText: vi.fn() }));
vi.mock("../domain/iter/pilots.js", () => ({ pilotIterDir: (t: string, i: string) => `/tmp/pilots/${t}/${i}` }));
vi.mock("./ner-candidates.js", () => ({ collectNerRefinementCandidates: vi.fn() }));

import {
  analyzeNerEntityType,
  buildNerAnalyzerPrompt,
  type AnalyzeNerInput,
} from "./ner-error-analysis.js";
import type { NerRefinementExample } from "./ner-candidates.js";

function ex(over: Partial<NerRefinementExample> = {}): NerRefinementExample {
  return {
    patient_id: "p1",
    agent_id: "agent_1",
    note_id: "n1",
    kind: "over_extraction",
    agent_text: "family of 4",
    agent_concept: "HouseholdSize",
    agent_entity_type: "Demographic",
    human_text: null,
    human_concept: null,
    human_entity_type: null,
    offsets: [10, 21],
    ...over,
  };
}

function input(over: Partial<AnalyzeNerInput> = {}): AnalyzeNerInput {
  return {
    taskId: "bso-ad-ner",
    entityType: "Demographic",
    guidanceText: "Tag demographic facts: age, gender, race. Prefer the most-specific child.",
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

describe("buildNerAnalyzerPrompt", () => {
  it("inlines the guidance + a labeled example line + the sentinel schema", () => {
    const p = buildNerAnalyzerPrompt(input());
    expect(p).toContain("GROUND TRUTH");
    expect(p).toContain("Demographic");
    expect(p).toContain("most-specific child"); // guidance text
    expect(p).toContain("OVER-EXTRACTION");
    expect(p).toContain("family of 4");
    expect(p).toContain("<ERROR_ANALYSIS>");
    expect(p).toContain("rubric_gap");
    expect(p).toContain("model_slip");
  });

  it("renders under-extraction and concept-mismatch lines", () => {
    const p = buildNerAnalyzerPrompt(
      input({
        examples: [
          ex({ kind: "under_extraction", agent_text: null, human_text: "67-year-old", human_concept: "Age", human_entity_type: "Demographic" }),
          ex({ kind: "concept_mismatch", agent_concept: "Male", human_text: "F", human_concept: "Female" }),
        ],
      }),
    );
    expect(p).toContain("UNDER-EXTRACTION");
    expect(p).toContain("67-year-old");
    expect(p).toContain("CONCEPT MISMATCH");
  });
});

describe("analyzeNerEntityType", () => {
  it("returns the parsed analysis (rubric_gap) on a well-formed sentinel", async () => {
    fakeResultText = wrap({
      error_class: "rubric_gap",
      what_rubric_misses: "No negative example for household-size phrases like 'family of 4'.",
      reasoning: "Guidance lists demographic facts but never excludes household size, so the agent over-extracts it.",
    });
    const out = await analyzeNerEntityType(input());
    expect(out.ok).toBe(true);
    expect(out.analysis?.error_class).toBe("rubric_gap");
    expect(out.analysis?.what_rubric_misses).toMatch(/household/i);
    expect(capturedPrompt).toContain("ENTITY-TYPE error analyst");
  });

  it("classifies a model_slip", async () => {
    fakeResultText = wrap({ error_class: "model_slip", what_rubric_misses: "", reasoning: "Guidance already lists this as a negative example." });
    const out = await analyzeNerEntityType(input());
    expect(out.analysis?.error_class).toBe("model_slip");
  });

  it("fails cleanly with no examples", async () => {
    const out = await analyzeNerEntityType(input({ examples: [] }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no examples/i);
  });

  it("fails cleanly when the sentinel is missing", async () => {
    fakeResultText = "I think this is a guideline gap.";
    const out = await analyzeNerEntityType(input());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/sentinel/i);
  });

  it("surfaces a runAgent error", async () => {
    runAgent.mockImplementationOnce(async function* () {
      yield { type: "error", error: "model down" } as const;
    });
    const out = await analyzeNerEntityType(input());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/model down/);
  });
});
