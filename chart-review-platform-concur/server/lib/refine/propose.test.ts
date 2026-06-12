import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks. Declared before importing the module under test so they're in
//    place at import time. We mock the LLM (agent-provider) to control the
//    refiner's output + capture the prompt it was given, and stub the disk /
//    model helpers so the unit test never touches the filesystem or a real
//    model. ──────────────────────────────────────────────────────────────────

let capturedPrompt = "";
let capturedExtraSystem = "";
/** The text the fake agent "emits" as its final result. */
let fakeResultText = "";

const runAgent = vi.fn(async function* (input: {
  prompt: string;
  extraSystemPrompt?: string;
}) {
  capturedPrompt = input.prompt;
  capturedExtraSystem = input.extraSystemPrompt ?? "";
  yield { type: "result", result: fakeResultText, cost_usd: 0.012 } as const;
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

import {
  proposeRubricEdit,
  scanForLeakage,
  buildRefinerPrompt,
} from "./propose.js";
import type { RefinementExample } from "./candidates.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

function ex(over: Partial<RefinementExample> = {}): RefinementExample {
  return {
    patient_id: "pt-101",
    agent_id: "default",
    note_id: "onco-note-1",
    excerpt: "Recurrent disease at the resection bed; no distant metastasis.",
    offsets: [10, 70],
    agent_answer: "no",
    reviewer_answer: "yes",
    classification_hint: "guideline_gap",
    judge_reasoning: "The note states 'recurrent' explicitly at the local site.",
    ...over,
  };
}

const CRITERION_DEF =
  "Is a local recurrence documented?\n\nWhether the chart documents a local " +
  "recurrence after prior definitive treatment.";

function wrap(obj: unknown): string {
  return `Some preamble.\n<REFINE_PROPOSAL>\n${JSON.stringify(obj)}\n</REFINE_PROPOSAL>\ntrailing.`;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedPrompt = "";
  capturedExtraSystem = "";
  fakeResultText = "";
});

// ── Prompt construction ──────────────────────────────────────────────────────

describe("buildRefinerPrompt", () => {
  it("includes the criterion def, every example, and the generalization instruction", () => {
    const prompt = buildRefinerPrompt({
      taskId: "cancer-diagnosis",
      fieldId: "has_local_recurrence",
      criterionDef: CRITERION_DEF,
      examples: [ex(), ex({ patient_id: "pt-202", reviewer_answer: "yes" })],
    });
    // criterion text present
    expect(prompt).toContain("Whether the chart documents a local recurrence");
    // both examples present (agent + reviewer answers + judge reasoning)
    expect(prompt).toContain("pt-101");
    expect(prompt).toContain("pt-202");
    expect(prompt).toContain("agent answered");
    expect(prompt).toContain("reviewer (correct) answer");
    expect(prompt).toContain("judge reasoning");
    // generalization discipline is spelled out, NOT instance memorization
    expect(prompt).toMatch(/GENERALIZE THE PATTERN/);
    expect(prompt).toContain('Do NOT write "for patient X, answer Y"');
    expect(prompt).toMatch(/Do NOT[\s\S]*reference any patient id/);
    // the strict schema + sentinel are inlined
    expect(prompt).toContain("<REFINE_PROPOSAL>");
    expect(prompt).toContain("proposed_rule_text");
  });
});

// ── End-to-end (mocked LLM) parse + validate ─────────────────────────────────

describe("proposeRubricEdit — parse + validate", () => {
  it("parses a well-formed proposal and passes it through", async () => {
    fakeResultText = wrap({
      gap_summary: "The criterion does not say a positive surgical margin alone is not recurrence.",
      proposed_rule_text:
        "When the note uses an explicit recurrence word (recurrent/relapse) at " +
        "or near the primary site after prior definitive treatment, answer yes " +
        "even if no distant disease is present.",
      rationale:
        "All examples turned on an explicit recurrence statement that the agent " +
        "missed; making the recurrence-word trigger explicit resolves the class.",
    });

    const out = await proposeRubricEdit({
      taskId: "cancer-diagnosis",
      fieldId: "has_local_recurrence",
      criterionDef: CRITERION_DEF,
      examples: [ex()],
    });

    expect(out.ok).toBe(true);
    expect(out.proposal?.gap_summary).toMatch(/surgical margin/);
    expect(out.proposal?.proposed_rule_text).toMatch(/explicit recurrence word/);
    expect(out.proposal?.rationale).toMatch(/explicit recurrence/);
    expect(out.proposal?.leakage_warning).toBeUndefined();
    expect(out.model).toBe("claude-sonnet");
    expect(out.cost_usd).toBeCloseTo(0.012);
    // The prompt the LLM actually saw carried the criterion + examples.
    expect(capturedPrompt).toContain("has_local_recurrence");
    expect(capturedPrompt).toContain("pt-101");
    expect(capturedExtraSystem).toMatch(/refiner/i);
  });

  it("errors when the sentinel is missing", async () => {
    fakeResultText = "I think the rule should be... (no sentinel)";
    const out = await proposeRubricEdit({
      taskId: "cancer-diagnosis",
      fieldId: "has_local_recurrence",
      criterionDef: CRITERION_DEF,
      examples: [ex()],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/missing <REFINE_PROPOSAL> sentinel/);
  });

  it("errors when a required field is missing (schema miss)", async () => {
    fakeResultText = wrap({
      gap_summary: "only this field",
      // proposed_rule_text + rationale omitted
    });
    const out = await proposeRubricEdit({
      taskId: "cancer-diagnosis",
      fieldId: "has_local_recurrence",
      criterionDef: CRITERION_DEF,
      examples: [ex()],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/schema validation/);
  });

  it("errors with no examples", async () => {
    const out = await proposeRubricEdit({
      taskId: "cancer-diagnosis",
      fieldId: "has_local_recurrence",
      criterionDef: CRITERION_DEF,
      examples: [],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no examples/);
  });
});

// ── Leakage scan ─────────────────────────────────────────────────────────────

describe("scanForLeakage", () => {
  const examples = [
    ex({
      patient_id: "pt-9087",
      excerpt: "Patient with recurrent left upper lobe adenocarcinoma at the prior resection bed.",
      reviewer_answer: "yes",
    }),
  ];

  it("flags a rule that names a patient id", () => {
    const warn = scanForLeakage(
      "For patient pt-9087, the answer should be yes.",
      examples,
    );
    expect(warn).toMatch(/patient id/);
    expect(warn).toContain("pt-9087");
  });

  it("flags a rule that copies a long verbatim slice of a note excerpt", () => {
    const warn = scanForLeakage(
      "Answer yes when the chart says: recurrent left upper lobe adenocarcinoma at the prior resection bed.",
      examples,
    );
    expect(warn).toMatch(/verbatim slice/);
  });

  it("flags a rule that copies a long verbatim reviewer answer", () => {
    const longGold =
      "this patient has unambiguous locally recurrent disease at the surgical bed";
    const warn = scanForLeakage(
      `Apply this verdict: ${longGold}.`,
      [ex({ reviewer_answer: longGold })],
    );
    expect(warn).toMatch(/reviewer answer/);
  });

  it("does NOT flag a genuinely generalizable rule", () => {
    const warn = scanForLeakage(
      "When an explicit recurrence word (recurrent/relapse) describes return of " +
        "disease at or near the primary site after prior definitive treatment, " +
        "answer yes regardless of distant-metastasis status.",
      examples,
    );
    expect(warn).toBeNull();
  });

  it("does NOT flag a short enum token shared with the reviewer answer", () => {
    // "yes" is a legitimate value to name in a rule — short, not memorization.
    const warn = scanForLeakage(
      "Answer yes whenever a recurrence word is present at the local site.",
      [ex({ reviewer_answer: "yes" })],
    );
    expect(warn).toBeNull();
  });

  it("attaches the leakage_warning to a proposal whose rule leaks a patient id", async () => {
    fakeResultText = wrap({
      gap_summary: "gap",
      proposed_rule_text: "For patient pt-101 specifically, answer yes.",
      rationale: "because",
    });
    const out = await proposeRubricEdit({
      taskId: "cancer-diagnosis",
      fieldId: "has_local_recurrence",
      criterionDef: CRITERION_DEF,
      examples: [ex({ patient_id: "pt-101" })],
    });
    expect(out.ok).toBe(true); // schema-valid; the guard FLAGS, doesn't reject
    expect(out.proposal?.leakage_warning).toMatch(/patient id/);
  });
});
