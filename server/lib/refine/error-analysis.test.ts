import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks. Declared before importing the module under test. We mock the LLM
//    (agent-provider) to control the analyst's output + capture its prompt, and
//    stub the disk / model / candidates helpers so the unit test never touches
//    the filesystem, a real model, or the candidates collector. ───────────────

let capturedPrompt = "";
let fakeResultText = "";

// The agent stream yields result OR error events; annotate the union so tests
// can inject an error-only generator via mockImplementationOnce.
type MockAgentEvent =
  | { type: "result"; result: string; cost_usd: number }
  | { type: "error"; error: string };
const runAgent = vi.fn(async function* (
  input: { prompt: string; extraSystemPrompt?: string },
): AsyncGenerator<MockAgentEvent> {
  capturedPrompt = input.prompt;
  yield { type: "result", result: fakeResultText, cost_usd: 0.004 };
});

vi.mock("../agent-provider.js", () => ({
  runAgent: (input: { prompt: string; extraSystemPrompt?: string }) => runAgent(input),
}));
vi.mock("@chart-review/model-config", () => ({
  modelFor: (slot: string) => (slot === "judge" ? "claude-sonnet" : "claude-haiku"),
}));
vi.mock("@chart-review/patients", () => ({
  patientDir: (pid: string) => `/tmp/patients/${pid}`,
  PLATFORM_ROOT: "/tmp/platform",
  isPhiPatient: () => false,
}));
vi.mock("@chart-review/rubric", () => ({
  phenotypeSkillDir: (id: string) => `/tmp/skills/${id}`,
}));
vi.mock("@chart-review/tasks", () => ({
  loadCompiledTask: () => ({ task_id: "cancer-diagnosis", task_kind: "phenotype" }),
}));
vi.mock("@chart-review/mcp-server-anthropic", () => ({
  buildMcpServersConfig: () => ({ chart_review_state: {} }),
}));
vi.mock("../storage.js", () => ({ atomicWriteJson: vi.fn() }));
vi.mock("../domain/iter/pilots.js", () => ({ pilotIterDir: (t: string, i: string) => `/tmp/pilots/${t}/${i}` }));
vi.mock("./candidates.js", () => ({ collectRefinementCandidates: vi.fn() }));

import {
  analyzeMismatch,
  buildAnalyzerPrompt,
  validateAnalysis,
  errorClassToHint,
  type AnalyzeMismatchInput,
} from "./error-analysis.js";

function input(over: Partial<AnalyzeMismatchInput> = {}): AnalyzeMismatchInput {
  return {
    taskId: "cancer-diagnosis",
    fieldId: "cancer_type",
    criterionDef:
      "What is the cancer histology type?\n\nMap small cell → neuroendocrine_tumor; " +
      "take the most recent pathologic diagnosis on conflict.",
    patientId: "patient_fake_cancer_01",
    humanAnswer: "adenocarcinoma",
    modelAnswer: "neuroendocrine_tumor",
    modelRationale: "The original diagnosis line says small-cell carcinoma.",
    excerpt: "DIAGNOSIS (ORIGINAL): SMALL-CELL CARCINOMA. ADDENDUM re-read: adenocarcinoma.",
    noteId: "2025-02-28__surgical_pathology_with_addendum",
    ...over,
  };
}

function wrap(obj: unknown): string {
  return `preamble\n<ERROR_ANALYSIS>\n${JSON.stringify(obj)}\n</ERROR_ANALYSIS>\ntrailing`;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedPrompt = "";
  fakeResultText = "";
});

describe("errorClassToHint", () => {
  it("maps the three error classes onto the judge vocabulary", () => {
    expect(errorClassToHint("rubric_gap")).toBe("guideline_gap");
    expect(errorClassToHint("genuine_ambiguity")).toBe("true_ambiguity");
    expect(errorClassToHint("model_slip")).toBe("agent_error");
  });
});

describe("validateAnalysis", () => {
  it("accepts a well-formed rubric_gap record", () => {
    const a = validateAnalysis({
      error_class: "rubric_gap",
      what_rubric_misses: "No rule for re-read addenda superseding the original read.",
      reasoning: "The criterion only covers transformation, not re-reads.",
    });
    expect(a?.error_class).toBe("rubric_gap");
    expect(a?.what_rubric_misses).toContain("re-read");
  });

  it("accepts model_slip with empty what_rubric_misses", () => {
    const a = validateAnalysis({ error_class: "model_slip", what_rubric_misses: "", reasoning: "Criterion was clear." });
    expect(a?.error_class).toBe("model_slip");
    expect(a?.what_rubric_misses).toBe("");
  });

  it("defaults what_rubric_misses to empty when absent", () => {
    const a = validateAnalysis({ error_class: "model_slip", reasoning: "clear" });
    expect(a?.what_rubric_misses).toBe("");
  });

  it("rejects an unknown error_class", () => {
    expect(validateAnalysis({ error_class: "rubric_bug", reasoning: "x" })).toBeNull();
  });

  it("rejects a missing/empty reasoning", () => {
    expect(validateAnalysis({ error_class: "rubric_gap", reasoning: "" })).toBeNull();
    expect(validateAnalysis({ error_class: "rubric_gap" })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(validateAnalysis(null)).toBeNull();
    expect(validateAnalysis("rubric_gap")).toBeNull();
  });
});

describe("buildAnalyzerPrompt", () => {
  it("frames the human answer as ground truth and includes the three classes + both answers", () => {
    const prompt = buildAnalyzerPrompt(input());
    expect(prompt).toContain("GROUND TRUTH");
    expect(prompt).toContain("rubric_gap");
    expect(prompt).toContain("genuine_ambiguity");
    expect(prompt).toContain("model_slip");
    expect(prompt).toContain('"neuroendocrine_tumor"'); // model answer
    expect(prompt).toContain('"adenocarcinoma"'); // human answer
    expect(prompt).toContain("<ERROR_ANALYSIS>");
    // the criterion text + the model rationale are inlined
    expect(prompt).toContain("most recent pathologic diagnosis");
    expect(prompt).toContain("small-cell carcinoma");
  });

  it("tolerates a missing excerpt / rationale", () => {
    const prompt = buildAnalyzerPrompt(input({ excerpt: null, modelRationale: null }));
    expect(prompt).toContain("(no reviewer-cited excerpt)");
    expect(prompt).toContain("(none recorded)");
  });
});

describe("analyzeMismatch", () => {
  it("returns the parsed analysis on a well-formed sentinel response", async () => {
    fakeResultText = wrap({
      error_class: "rubric_gap",
      what_rubric_misses: "No re-read/addendum supersedence rule.",
      reasoning: "Criterion only handles transformation; a careful reader could anchor on the original line.",
    });
    const out = await analyzeMismatch(input());
    expect(out.ok).toBe(true);
    expect(out.analysis?.error_class).toBe("rubric_gap");
    expect(out.analysis?.what_rubric_misses).toContain("re-read");
    expect(out.cost_usd).toBeCloseTo(0.004);
    // it actually asked the model (prompt captured)
    expect(capturedPrompt).toContain("ERROR ANALYST");
  });

  it("fails cleanly when the sentinel is missing", async () => {
    fakeResultText = "I think this is a rubric gap.";
    const out = await analyzeMismatch(input());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/sentinel/i);
  });

  it("fails cleanly on invalid JSON inside the sentinel", async () => {
    fakeResultText = "<ERROR_ANALYSIS>\n{not json}\n</ERROR_ANALYSIS>";
    const out = await analyzeMismatch(input());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not valid JSON/i);
  });

  it("fails schema validation on a bad error_class", async () => {
    fakeResultText = wrap({ error_class: "nonsense", reasoning: "x" });
    const out = await analyzeMismatch(input());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/schema validation/i);
  });

  it("surfaces a runAgent error", async () => {
    runAgent.mockImplementationOnce(async function* () {
      yield { type: "error", error: "model unavailable" } as const;
    });
    const out = await analyzeMismatch(input());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/model unavailable/);
  });
});
