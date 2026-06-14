import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedPrompt = "";
let fakeResultText = "";
const runAgent = vi.fn(async function* (input: { prompt: string }) {
  capturedPrompt = input.prompt;
  yield { type: "result", result: fakeResultText, cost_usd: 0.005 } as const;
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

import {
  proposeNerGuidanceEdit,
  buildNerRefinerPrompt,
  scanNerLeakage,
  type ProposeNerEditInput,
} from "./ner-propose.js";
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

function input(over: Partial<ProposeNerEditInput> = {}): ProposeNerEditInput {
  return {
    taskId: "bso-ad-ner",
    entityType: "Demographic",
    guidanceText: "Tag demographic facts: age, gender, race, marital status.",
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

describe("buildNerRefinerPrompt", () => {
  it("inlines guidance + the error lines + the generalize instruction + sentinel", () => {
    const p = buildNerRefinerPrompt(input());
    expect(p).toContain("guidance REFINER");
    expect(p).toContain("Demographic");
    expect(p).toContain("marital status"); // guidance
    expect(p).toContain("OVER-EXTRACTION");
    expect(p).toContain("family of 4");
    expect(p).toContain("GENERALIZE");
    expect(p).toContain("<REFINE_PROPOSAL>");
  });
});

describe("scanNerLeakage", () => {
  it("flags a verbatim ≥40-char span copy", () => {
    const longText = "the patient lives with seven other relatives in one home";
    const examples = [ex({ agent_text: longText })];
    expect(scanNerLeakage(`Do not tag phrases like ${longText} as demographics.`, examples)).toMatch(/verbatim/i);
  });
  it("passes a generalized rule that names no verbatim span", () => {
    expect(scanNerLeakage("Do NOT tag household-size phrases as demographic concepts.", [ex()])).toBeNull();
  });
});

describe("proposeNerGuidanceEdit", () => {
  it("returns the proposal on a well-formed sentinel", async () => {
    fakeResultText = wrap({
      gap_summary: "No negative example for household-size phrases.",
      proposed_guidance_addition: "Do NOT tag household-size phrases such as 'family of N' — household size is not a demographic concept.",
      rationale: "Generalizes the over-extraction across notes.",
    });
    const out = await proposeNerGuidanceEdit(input());
    expect(out.ok).toBe(true);
    expect(out.proposal?.proposed_guidance_addition).toMatch(/household-size/i);
    expect(out.proposal?.leakage_warning).toBeUndefined();
    expect(capturedPrompt).toContain("guidance REFINER");
  });

  it("attaches a leakage_warning when the addition copies a span verbatim", async () => {
    const longText = "lives with seven other relatives in a single bedroom apartment";
    fakeResultText = wrap({
      gap_summary: "gap",
      proposed_guidance_addition: `Do not tag ${longText} as demographic.`,
      rationale: "r",
    });
    const out = await proposeNerGuidanceEdit(input({ examples: [ex({ agent_text: longText })] }));
    expect(out.ok).toBe(true);
    expect(out.proposal?.leakage_warning).toMatch(/verbatim/i);
  });

  it("fails on missing sentinel / schema / no examples", async () => {
    fakeResultText = "no sentinel here";
    expect((await proposeNerGuidanceEdit(input())).error).toMatch(/sentinel/i);
    fakeResultText = wrap({ gap_summary: "x" }); // missing fields
    expect((await proposeNerGuidanceEdit(input())).error).toMatch(/schema/i);
    expect((await proposeNerGuidanceEdit(input({ examples: [] }))).error).toMatch(/no examples/i);
  });
});
