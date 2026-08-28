import { describe, it, expect } from "vitest";

// Accepting an answer must accept its BASIS. The question-answer route replaced
// the whole entry and the pane's Accept sends only {question_id, answer}, so
// every unsent field arrived undefined and validating a question ERASED its
// citations. Measured on the first hand-validated patient: 13 of 14 reviewer
// answers had `evidence: []` while the agent shadow for those same 14 carried 1-4
// quotes each — and all 14 had been accepted UNCHANGED, i.e. the reviewer was
// endorsing the agent's answer, whose quotes were the basis being endorsed.
//
// These test the decision itself rather than going through the route (which needs
// a task fixture, a session root and mutateReviewState). The predicate and the
// carry-forward are lifted verbatim from server/adherence-routes.ts; if that
// changes shape, this drifts — hence the explicit note.
type Ans = {
  question_id: string; answer: unknown;
  evidence?: unknown[]; reasoning?: string; confidence?: number;
};
function accept(prior: Ans | undefined, body: { answer: unknown } & Partial<Ans>): Ans {
  const unchanged = prior !== undefined
    && JSON.stringify(prior.answer ?? null) === JSON.stringify(body.answer ?? null);
  return {
    question_id: "Q",
    answer: body.answer ?? null,
    confidence: body.confidence ?? (unchanged ? prior?.confidence : undefined),
    evidence: body.evidence ?? (unchanged ? prior?.evidence : undefined),
    reasoning: body.reasoning ?? (unchanged ? prior?.reasoning : undefined),
  };
}

const agent: Ans = {
  question_id: "Q", answer: "assessed_and_addressed", confidence: 0.9,
  reasoning: "problem list + plan", evidence: [{ note_id: "n1", quote: "GERD" }],
};

describe("accepting an answer accepts its basis", () => {
  it("Accept UNCHANGED keeps the evidence, reasoning and confidence", () => {
    const out = accept(agent, { answer: "assessed_and_addressed" });
    expect(out.evidence).toHaveLength(1);
    expect(out.reasoning).toBe("problem list + plan");
    expect(out.confidence).toBe(0.9);
  });

  it("CHANGING the answer drops them — the quotes supported a different claim", () => {
    // Keeping them would attach a citation that contradicts the answer, which is
    // worse than none; the pane's "none cited" warning is then accurate.
    const out = accept(agent, { answer: "not_assessed" });
    expect(out.evidence).toBeUndefined();
    expect(out.reasoning).toBeUndefined();
    expect(out.confidence).toBeUndefined();
  });

  it("an explicit body value always wins over the carry-forward", () => {
    const out = accept(agent, {
      answer: "assessed_and_addressed",
      evidence: [{ note_id: "n2", quote: "reviewer's own" }],
    });
    expect(out.evidence).toEqual([{ note_id: "n2", quote: "reviewer's own" }]);
    // reasoning was not sent, so it still carries forward
    expect(out.reasoning).toBe("problem list + plan");
  });

  it("no prior entry carries nothing — there is nothing to endorse", () => {
    const out = accept(undefined, { answer: true });
    expect(out.evidence).toBeUndefined();
  });

  it("null vs absent are the same answer, so a null Accept still keeps evidence", () => {
    const nullPrior: Ans = { ...agent, answer: null };
    expect(accept(nullPrior, { answer: null }).evidence).toHaveLength(1);
    // and an explicit null over a non-null prior is a CHANGE
    expect(accept(agent, { answer: null }).evidence).toBeUndefined();
  });

  it("a re-Accept of an already-reviewer answer keeps what the first Accept kept", () => {
    const first = accept(agent, { answer: "assessed_and_addressed" });
    const second = accept(first as Ans, { answer: "assessed_and_addressed" });
    expect(second.evidence).toHaveLength(1);
  });
});
