import { describe, it, expect } from "vitest";

import { setQuestionAnswerArgsSchema, setEventAnswerArgsSchema } from "./index.js";

// REASONING IS THE DATA, not a nicety. A reasoning-evaluation study scores the
// agent's stated justification per answer; an answer committed without one is a
// hole in the dataset that cannot be filled after the fact without re-running
// the whole cohort.
//
// The live failure this closes: in the 2026-09-30 lung-cancer batch (5 real
// patients x 18 questions) the field was `.optional()`, and the agent simply
// skipped it — one patient committed 9 of 18 answers with no reasoning at all,
// another 16 of 18. The run looked clean: 90/90 answers, 0 errors.

describe("set_question_answer requires reasoning", () => {
  const base = { question_id: "MT1", answer: "yes" };

  it("rejects an answer committed without reasoning", () => {
    expect(setQuestionAnswerArgsSchema.safeParse(base).success).toBe(false);
  });

  it("rejects empty / whitespace-only reasoning", () => {
    expect(setQuestionAnswerArgsSchema.safeParse({ ...base, reasoning: "" }).success).toBe(false);
    expect(setQuestionAnswerArgsSchema.safeParse({ ...base, reasoning: "   " }).success).toBe(false);
  });

  it("accepts an answer that states its reasoning", () => {
    const r = setQuestionAnswerArgsSchema.safeParse({
      ...base,
      reasoning: "The pathology addendum documents an NGS panel with reported findings.",
    });
    expect(r.success).toBe(true);
  });
});

describe("set_event_answer requires reasoning per answer", () => {
  const evt = { event_id: "e1" };

  it("rejects an event answer committed without reasoning", () => {
    const r = setEventAnswerArgsSchema.safeParse({
      ...evt,
      answers: [{ question_id: "T1-ControllerPrescribed", answer: true }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts an event answer that states its reasoning", () => {
    const r = setEventAnswerArgsSchema.safeParse({
      ...evt,
      answers: [
        {
          question_id: "T1-ControllerPrescribed",
          answer: true,
          reasoning: "The 2025-03-04 visit note lists a daily ICS on the active med list.",
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("still accepts an event marked non-evaluable with no answers", () => {
    const r = setEventAnswerArgsSchema.safeParse({
      ...evt,
      evaluable: false,
      evaluable_reason: "the encounter predates the measurement window",
      answers: [],
    });
    expect(r.success).toBe(true);
  });
});
