import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks. Declared before importing the module under test so they're in place
//    at import time. We mock the extraction LLM (agent-provider) to control the
//    per-call answer + capture the prompts it was given, and stub the disk /
//    model / patients helpers so the unit test never touches the filesystem or
//    a real model. ────────────────────────────────────────────────────────────

/** Prompts the fake extractor saw, in call order. */
let capturedPrompts: string[] = [];
/** Answers the fake extractor "emits", consumed in call order. A `null` entry
 *  simulates a failed extraction (no sentinel). */
let answerQueue: Array<unknown | null> = [];
let callIdx = 0;

const runAgent = vi.fn(async function* (input: { prompt: string }) {
  capturedPrompts.push(input.prompt);
  const ans = answerQueue[callIdx++];
  if (ans === null || ans === undefined) {
    // No sentinel → extractOnce reports a failure.
    yield { type: "result", result: "I am not sure.", cost_usd: 0.001 } as const;
    return;
  }
  yield {
    type: "result",
    result: `<EXTRACT>\n${JSON.stringify({ answer: ans })}\n</EXTRACT>`,
    cost_usd: 0.002,
  } as const;
});

vi.mock("../agent-provider.js", () => ({
  runAgent: (input: { prompt: string }) => runAgent(input),
}));
vi.mock("@chart-review/model-config", () => ({
  modelFor: (slot: string) => (slot === "judge" ? "claude-sonnet" : "claude-haiku"),
}));
vi.mock("@chart-review/patients", () => ({
  patientDir: (pid: string) => `/tmp/patients/${pid}`,
  PLATFORM_ROOT: "/tmp/platform",
  isPhiPatient: () => false,
  listNotes: (_pid: string) => [{ filename: "2024-01-01__onco.txt", date: "2024-01-01", doctype: "onco" }],
  readNote: (_pid: string, _fn: string) => "Patient has recurrent disease at the local site.",
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
  splitValidatedPatients,
  rescoreCriterionOnHeldout,
  buildExtractionPrompt,
  answersAgree,
  DEFAULT_HELDOUT_FRACTION,
  MIN_HELDOUT,
} from "./holdout.js";

beforeEach(() => {
  vi.clearAllMocks();
  capturedPrompts = [];
  answerQueue = [];
  callIdx = 0;
});

// ── Split: determinism, fraction, stability ──────────────────────────────────

describe("splitValidatedPatients", () => {
  const cohort = Array.from({ length: 50 }, (_, i) => `patient_${String(i).padStart(3, "0")}`);

  it("is deterministic — same cohort splits the same way every time", () => {
    const a = splitValidatedPatients(cohort);
    const b = splitValidatedPatients(cohort);
    expect(a).toEqual(b);
  });

  it("partitions every patient exactly once (refine ∪ heldout = cohort, disjoint)", () => {
    const { refine, heldout } = splitValidatedPatients(cohort);
    expect([...refine, ...heldout].sort()).toEqual([...cohort].sort());
    const overlap = refine.filter((p) => heldout.includes(p));
    expect(overlap).toEqual([]);
  });

  it("respects the held-out fraction roughly (default ~40%)", () => {
    const { heldout } = splitValidatedPatients(cohort, DEFAULT_HELDOUT_FRACTION);
    const ratio = heldout.length / cohort.length;
    // Hash distribution is approximate on 50 patients; allow a generous band.
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.6);
  });

  it("fraction 0 → everything in refine; fraction 1 → everything held-out", () => {
    expect(splitValidatedPatients(cohort, 0).heldout).toEqual([]);
    expect(splitValidatedPatients(cohort, 1).refine).toEqual([]);
  });

  it("a patient's bucket is stable as the cohort grows (no reshuffle)", () => {
    const small = splitValidatedPatients(cohort.slice(0, 10));
    const big = splitValidatedPatients(cohort);
    // Each of the first 10 patients stays on the same side in the bigger split.
    for (const pid of cohort.slice(0, 10)) {
      const inHeldoutSmall = small.heldout.includes(pid);
      const inHeldoutBig = big.heldout.includes(pid);
      expect(inHeldoutSmall).toBe(inHeldoutBig);
    }
  });

  it("dedupes input patient ids", () => {
    const { refine, heldout } = splitValidatedPatients(["p1", "p1", "p2"]);
    expect([...refine, ...heldout].sort()).toEqual(["p1", "p2"]);
  });
});

// ── answersAgree ─────────────────────────────────────────────────────────────

describe("answersAgree", () => {
  it("normalizes scalar string case + whitespace", () => {
    expect(answersAgree(" Yes ", "yes")).toBe(true);
    expect(answersAgree("no", "yes")).toBe(false);
  });
  it("deep-compares non-strings", () => {
    expect(answersAgree({ a: 1 }, { a: 1 })).toBe(true);
    expect(answersAgree(true, true)).toBe(true);
    expect(answersAgree(true, "yes")).toBe(false);
  });
});

// ── buildExtractionPrompt ────────────────────────────────────────────────────

describe("buildExtractionPrompt", () => {
  it("inlines the criterion, the enum, and the notes; forbids tools/files", () => {
    const prompt = buildExtractionPrompt({
      taskId: "cancer-diagnosis",
      fieldId: "has_local_recurrence",
      criterionText: "Is a local recurrence documented?",
      answerEnum: ["yes", "no", "no_info"],
      notesBlock: "### note.txt\nPatient has recurrent disease.",
    });
    expect(prompt).toContain("has_local_recurrence");
    expect(prompt).toContain("Is a local recurrence documented?");
    expect(prompt).toContain('"yes", "no", "no_info"');
    expect(prompt).toContain("Patient has recurrent disease");
    expect(prompt).toContain("<EXTRACT>");
    expect(prompt).toMatch(/do not read files/i);
  });
});

// ── rescoreCriterionOnHeldout: Δ / n_fixed / n_regressed ─────────────────────

const HELDOUT = ["pt_a", "pt_b", "pt_c", "pt_d"];
const GOLD = { pt_a: "yes", pt_b: "yes", pt_c: "no", pt_d: "yes" };

function rescore(answerSeq: Array<unknown | null>) {
  answerQueue = answerSeq;
  return rescoreCriterionOnHeldout({
    taskId: "cancer-diagnosis",
    fieldId: "has_local_recurrence",
    criterionTextOld: "OLD criterion text",
    criterionTextNew: "NEW criterion text (with rule)",
    heldoutPatients: HELDOUT,
    gold: GOLD,
    answerEnum: ["yes", "no", "no_info"],
  });
}

describe("rescoreCriterionOnHeldout", () => {
  it("computes agreement_old, agreement_new, delta, n_fixed, n_regressed", async () => {
    // Call order per patient: [old, new]. 4 patients = 8 calls.
    //   pt_a gold yes: old=no  (wrong)  new=yes (right)  → FIXED
    //   pt_b gold yes: old=yes (right)  new=yes (right)  → unchanged
    //   pt_c gold no : old=no  (right)  new=yes (wrong)  → REGRESSED
    //   pt_d gold yes: old=no  (wrong)  new=no  (wrong)  → unchanged
    const out = await rescore([
      "no", "yes",   // pt_a
      "yes", "yes",  // pt_b
      "no", "yes",   // pt_c
      "no", "no",    // pt_d
    ]);
    expect(out.insufficient_holdout).toBeFalsy();
    if (out.insufficient_holdout) return;
    expect(out.scored_n).toBe(4);
    // old right: pt_b, pt_c = 2/4 = 0.5
    expect(out.agreement_old).toBeCloseTo(0.5);
    // new right: pt_a, pt_b = 2/4 = 0.5
    expect(out.agreement_new).toBeCloseTo(0.5);
    expect(out.delta).toBeCloseTo(0);
    expect(out.n_fixed).toBe(1); // pt_a
    expect(out.n_regressed).toBe(1); // pt_c
    // Two calls per patient.
    expect(runAgent).toHaveBeenCalledTimes(8);
    expect(out.model).toBe("claude-sonnet");
    // Cost summed across all calls (0.002 each).
    expect(out.cost_usd).toBeCloseTo(8 * 0.002);
  });

  it("reports a positive delta when the new rule fixes cases without regressions", async () => {
    const out = await rescore([
      "no", "yes",  // pt_a: wrong → right (FIXED)
      "no", "yes",  // pt_b: wrong → right (FIXED)
      "no", "no",   // pt_c: right → right
      "no", "yes",  // pt_d: wrong → right (FIXED)
    ]);
    if (out.insufficient_holdout) throw new Error("unexpected insufficient_holdout");
    expect(out.agreement_old).toBeCloseTo(1 / 4); // only pt_c right
    expect(out.agreement_new).toBeCloseTo(4 / 4); // all right
    expect(out.delta).toBeCloseTo(0.75);
    expect(out.n_fixed).toBe(3);
    expect(out.n_regressed).toBe(0);
  });

  it("passes the OLD text to the first call and the NEW text to the second per patient", async () => {
    await rescore(["yes", "yes", "yes", "yes", "yes", "yes", "yes", "yes"]);
    // First patient's two calls: prompt[0] carries OLD, prompt[1] carries NEW.
    expect(capturedPrompts[0]).toContain("OLD criterion text");
    expect(capturedPrompts[0]).not.toContain("NEW criterion text");
    expect(capturedPrompts[1]).toContain("NEW criterion text (with rule)");
  });

  // ── min-holdout guard ──────────────────────────────────────────────────────

  it("returns insufficient_holdout when held-out < MIN_HELDOUT (no LLM calls)", async () => {
    answerQueue = [];
    const out = await rescoreCriterionOnHeldout({
      taskId: "cancer-diagnosis",
      fieldId: "has_local_recurrence",
      criterionTextOld: "OLD",
      criterionTextNew: "NEW",
      heldoutPatients: ["pt_a", "pt_b"], // < MIN_HELDOUT (3)
      gold: { pt_a: "yes", pt_b: "no" },
    });
    expect(out.insufficient_holdout).toBe(true);
    if (!out.insufficient_holdout) return;
    expect(out.heldout_n).toBe(2);
    // No extraction calls made — the guard short-circuits before any LLM work.
    expect(runAgent).not.toHaveBeenCalled();
    expect(MIN_HELDOUT).toBe(3);
  });

  it("excludes a failed-extraction patient from the denominator, and disclaims if too few remain", async () => {
    // pt_a old call fails (null) → pt_a excluded. Only pt_b/pt_c/pt_d scored = 3.
    const out = await rescore([
      null, "yes",   // pt_a: old extraction fails → excluded
      "yes", "yes",  // pt_b
      "no", "no",    // pt_c
      "yes", "yes",  // pt_d
    ]);
    if (out.insufficient_holdout) throw new Error("3 scored ≥ MIN_HELDOUT, should not disclaim");
    expect(out.heldout_n).toBe(4);
    expect(out.scored_n).toBe(3); // pt_a dropped
    // pt_a is present in per_patient with an error.
    const pa = out.per_patient.find((p) => p.pid === "pt_a");
    expect(pa?.error).toMatch(/old:/);
  });

  it("disclaims when too many extractions fail to leave a usable denominator", async () => {
    // Only pt_a yields both answers; pt_b/pt_c/pt_d each fail one call → scored=1 < 3.
    const out = await rescore([
      "yes", "yes",  // pt_a ok
      null, "yes",   // pt_b old fails
      "no", null,    // pt_c new fails
      null, null,    // pt_d both fail
    ]);
    expect(out.insufficient_holdout).toBe(true);
    if (!out.insufficient_holdout) return;
    expect(out.heldout_n).toBe(4);
    expect(out.reason).toMatch(/usable answer/);
  });
});
