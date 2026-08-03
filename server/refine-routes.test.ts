import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks. The propose route orchestrates four collaborators; we mock all four
//    so the test asserts the WIRING (S3): the field's validated patients are
//    split, the refiner sees ONLY refine-set examples (held-out disagreements
//    excluded), and the held-out Δ (④) is attached to the card. ───────────────

const loadCompiledTask = vi.fn();
const collectRefinementCandidates = vi.fn();
const proposeRubricEdit = vi.fn();
const splitValidatedPatients = vi.fn();
const rescoreCriterionOnHeldout = vi.fn();

vi.mock("@chart-review/tasks", () => ({
  loadCompiledTask: (id: string) => loadCompiledTask(id),
}));
vi.mock("./lib/refine/candidates.js", () => ({
  collectRefinementCandidates: (opts: unknown) => collectRefinementCandidates(opts),
}));
vi.mock("./lib/refine/propose.js", () => ({
  proposeRubricEdit: (input: unknown) => proposeRubricEdit(input),
}));
vi.mock("./lib/refine/holdout.js", () => ({
  splitValidatedPatients: (pids: string[]) => splitValidatedPatients(pids),
  rescoreCriterionOnHeldout: (input: unknown) => rescoreCriterionOnHeldout(input),
}));

import { refineRoutes } from "./refine-routes.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function proposeHandler() {
  const entry = refineRoutes.find(
    (r) => r.method === "POST" && r.pattern.endsWith("/propose"),
  );
  if (!entry) throw new Error("propose route not found");
  return entry.handler;
}

/** Disagreement example fixtures, keyed by patient. */
const EX_REFINE_1 = {
  patient_id: "pt_refine_1",
  agent_id: "default",
  note_id: "n1",
  excerpt: "recurrent",
  offsets: [0, 9],
  agent_answer: "no",
  reviewer_answer: "yes",
  classification_hint: "guideline_gap",
  judge_reasoning: "gap",
};
const EX_HELDOUT_1 = {
  ...EX_REFINE_1,
  patient_id: "pt_heldout_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  loadCompiledTask.mockReturnValue({ task_id: "cancer-diagnosis", task_kind: "phenotype" });

  // Split: pt_refine_* → refine, pt_heldout_* → held-out (≥ MIN_HELDOUT).
  splitValidatedPatients.mockReturnValue({
    refine: ["pt_refine_1", "pt_refine_2"],
    heldout: ["pt_heldout_1", "pt_heldout_2", "pt_heldout_3"],
  });

  // collectRefinementCandidates: the UNFILTERED call (no examplePatientFilter)
  // returns full gold + a cluster with BOTH refine + held-out examples; the
  // FILTERED call honors examplePatientFilter and excludes held-out examples.
  collectRefinementCandidates.mockImplementation(
    (opts: { examplePatientFilter?: Set<string> }) => {
      const allExamples = [EX_REFINE_1, EX_HELDOUT_1];
      const examples = opts.examplePatientFilter
        ? allExamples.filter((e) => opts.examplePatientFilter!.has(e.patient_id))
        : allExamples;
      return {
        task_id: "cancer-diagnosis",
        iter_id: "iter_1",
        session_id: "sess_1",
        n_validated_patients: 5,
        gold_by_field: {
          has_local_recurrence: {
            pt_refine_1: "yes",
            pt_refine_2: "no",
            pt_heldout_1: "yes",
            pt_heldout_2: "no",
            pt_heldout_3: "yes",
          },
        },
        clusters: [
          {
            field_id: "has_local_recurrence",
            criterion_def: "Is a local recurrence documented?",
            answer_enum: ["yes", "no", "no_info"],
            examples,
            n_guideline_gap: examples.length,
            n_true_ambiguity: 0,
            n_agent_error: 0,
            n_unjudged: 0,
          },
        ],
      };
    },
  );

  proposeRubricEdit.mockResolvedValue({
    ok: true,
    proposal: {
      gap_summary: "criterion is silent on explicit recurrence words",
      proposed_rule_text: "- When an explicit recurrence word is present, answer yes.",
      rationale: "covers the failure class",
    },
    model: "claude-sonnet",
    cost_usd: 0.01,
    duration_ms: 100,
  });

  rescoreCriterionOnHeldout.mockResolvedValue({
    agreement_old: 0.33,
    agreement_new: 0.67,
    delta: 0.34,
    n_fixed: 1,
    n_regressed: 0,
    heldout_n: 3,
    scored_n: 3,
    per_patient: [],
    model: "claude-sonnet",
    cost_usd: 0.006,
    duration_ms: 200,
  });
});

describe("POST /propose — S3 wiring", () => {
  it("splits the field's validated patients and attaches the held-out ④", async () => {
    const handler = proposeHandler();
    const res = (await handler(
      { field_id: "has_local_recurrence" },
      {} as never,
      { taskId: "cancer-diagnosis", iterId: "iter_1" },
      new URLSearchParams({ session_id: "sess_1" }),
    )) as Record<string, unknown>;

    // Split was driven by the FULL field gold (all 5 validated patients).
    expect(splitValidatedPatients).toHaveBeenCalledWith(
      expect.arrayContaining([
        "pt_refine_1", "pt_refine_2", "pt_heldout_1", "pt_heldout_2", "pt_heldout_3",
      ]),
    );

    // ④ attached to the card.
    expect(res.holdout).toEqual({
      delta: 0.34,
      agreement_old: 0.33,
      agreement_new: 0.67,
      n_fixed: 1,
      n_regressed: 0,
      heldout_n: 3,
      scored_n: 3,
    });
    expect(res.refine_n).toBe(2);
  });

  it("the refiner sees ONLY refine-set examples (held-out disagreements excluded)", async () => {
    const handler = proposeHandler();
    await handler(
      { field_id: "has_local_recurrence" },
      {} as never,
      { taskId: "cancer-diagnosis", iterId: "iter_1" },
      new URLSearchParams({ session_id: "sess_1" }),
    );

    // The second collect call carried the refine-set filter.
    const filteredCall = collectRefinementCandidates.mock.calls.find(
      (c) => (c[0] as { examplePatientFilter?: Set<string> }).examplePatientFilter,
    );
    expect(filteredCall).toBeDefined();
    const filter = (filteredCall![0] as { examplePatientFilter: Set<string> }).examplePatientFilter;
    expect([...filter].sort()).toEqual(["pt_refine_1", "pt_refine_2"]);

    // The examples handed to the refiner contain NO held-out patient.
    const examplesToRefiner = (proposeRubricEdit.mock.calls[0][0] as {
      examples: Array<{ patient_id: string }>;
    }).examples;
    const pids = examplesToRefiner.map((e) => e.patient_id);
    expect(pids).toContain("pt_refine_1");
    expect(pids).not.toContain("pt_heldout_1");
  });

  it("re-scores the held-out set under candidate text = criterion + bullet-stripped rule", async () => {
    const handler = proposeHandler();
    const res = (await handler(
      { field_id: "has_local_recurrence" },
      {} as never,
      { taskId: "cancer-diagnosis", iterId: "iter_1" },
      new URLSearchParams({ session_id: "sess_1" }),
    )) as Record<string, unknown>;

    const rescoreArg = rescoreCriterionOnHeldout.mock.calls[0][0] as {
      criterionTextOld: string;
      criterionTextNew: string;
      heldoutPatients: string[];
      gold: Record<string, unknown>;
      answerEnum?: string[];
    };
    expect(rescoreArg.heldoutPatients).toEqual(["pt_heldout_1", "pt_heldout_2", "pt_heldout_3"]);
    expect(rescoreArg.criterionTextOld).toBe("Is a local recurrence documented?");
    // candidate text appends the rule as a single bullet (leading bullet stripped).
    expect(rescoreArg.criterionTextNew).toContain("Is a local recurrence documented?");
    expect(rescoreArg.criterionTextNew).toContain(
      "- When an explicit recurrence word is present, answer yes.",
    );
    // No double-bullet ("- - ").
    expect(rescoreArg.criterionTextNew).not.toMatch(/- -\s/);
    expect(rescoreArg.answerEnum).toEqual(["yes", "no", "no_info"]);
    // The proposed_rule_text returned on the card is bullet-stripped.
    expect(res.proposed_rule_text).toBe(
      "When an explicit recurrence word is present, answer yes.",
    );
    // gold passed to the re-score includes held-out patients.
    expect(rescoreArg.gold.pt_heldout_1).toBe("yes");
  });

  it("attaches insufficient_holdout when the re-score can't claim a Δ", async () => {
    rescoreCriterionOnHeldout.mockResolvedValueOnce({
      insufficient_holdout: true,
      heldout_n: 2,
      reason: "too few",
    });
    const handler = proposeHandler();
    const res = (await handler(
      { field_id: "has_local_recurrence" },
      {} as never,
      { taskId: "cancer-diagnosis", iterId: "iter_1" },
      new URLSearchParams({ session_id: "sess_1" }),
    )) as Record<string, unknown>;
    expect(res.holdout).toEqual({ insufficient_holdout: true, heldout_n: 2 });
  });

  it("rejects when no refine-set guideline-gap disagreements remain", async () => {
    // Refine set has no examples (all disagreements were in held-out).
    collectRefinementCandidates.mockImplementation(
      (opts: { examplePatientFilter?: Set<string> }) => {
        const examples = opts.examplePatientFilter ? [] : [EX_HELDOUT_1];
        return {
          task_id: "cancer-diagnosis",
          iter_id: "iter_1",
          session_id: "sess_1",
          n_validated_patients: 5,
          gold_by_field: { has_local_recurrence: { pt_heldout_1: "yes" } },
          clusters: [
            {
              field_id: "has_local_recurrence",
              criterion_def: "Is a local recurrence documented?",
              answer_enum: ["yes", "no"],
              examples,
              n_guideline_gap: examples.length,
              n_true_ambiguity: 0,
              n_agent_error: 0,
              n_unjudged: 0,
            },
          ],
        };
      },
    );
    const handler = proposeHandler();
    await expect(
      handler(
        { field_id: "has_local_recurrence" },
        {} as never,
        { taskId: "cancer-diagnosis", iterId: "iter_1" },
        new URLSearchParams({ session_id: "sess_1" }),
      ),
    ).rejects.toThrow(/refine set/);
    // Never spent an LLM call on the refiner or the re-score.
    expect(proposeRubricEdit).not.toHaveBeenCalled();
    expect(rescoreCriterionOnHeldout).not.toHaveBeenCalled();
  });
});
