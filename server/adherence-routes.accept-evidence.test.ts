import { describe, it, expect } from "vitest";
import { acceptedBasis } from "./adherence-routes.js";
import type { QuestionAnswer } from "@chart-review/platform-types";

// Accepting an answer must accept its BASIS. Both adherence write routes replaced
// the whole answer entry and the pane's Accept sends only {question_id, answer},
// so every unsent field arrived undefined and validating a question ERASED its
// citations. Measured on the first hand-validated patient: 13 of 14 reviewer
// answers had `evidence: []` while the agent shadow for those same 14 carried 1-4
// quotes each — and all 14 had been accepted UNCHANGED, i.e. the reviewer was
// endorsing the agent's answer, whose quotes were the basis being endorsed.
//
// These call the route's own exported decision, so they cannot drift from it.

const agent: QuestionAnswer = {
  question_id: "Q", tier: 1, answer: "assessed_and_addressed", confidence: 0.9,
  source: "agent", reasoning: "problem list + plan",
  evidence: [{ note_id: "n1", quote: "GERD" }],
};

describe("accepting an answer accepts its basis", () => {
  it("Accept UNCHANGED keeps the evidence, reasoning and confidence", () => {
    const out = acceptedBasis({ prior: agent, body: { answer: "assessed_and_addressed" } });
    expect(out.evidence).toHaveLength(1);
    expect(out.reasoning).toBe("problem list + plan");
    expect(out.confidence).toBe(0.9);
    // The prior held them itself, so nothing is being inherited here.
    expect(out.evidence_from).toBeUndefined();
  });

  it("CHANGING the answer drops them — the quotes supported a different claim", () => {
    // Keeping them would attach a citation that contradicts the answer, which is
    // worse than none; the pane's "none cited" warning is then accurate.
    const out = acceptedBasis({ prior: agent, body: { answer: "not_assessed" } });
    expect(out.evidence).toBeUndefined();
    expect(out.reasoning).toBeUndefined();
    expect(out.confidence).toBeUndefined();
  });

  it("an explicit body value always wins over both fallbacks", () => {
    const out = acceptedBasis({
      prior: agent, shadow: [agent],
      body: { answer: "assessed_and_addressed", evidence: [{ note_id: "n2", quote: "mine" }] },
    });
    expect(out.evidence).toEqual([{ note_id: "n2", quote: "mine" }]);
    expect(out.evidence_from).toBeUndefined();   // the reviewer's own reading
    expect(out.reasoning).toBe("problem list + plan"); // not sent -> still carried
  });

  it("no prior and no shadow carries nothing — there is nothing to endorse", () => {
    expect(acceptedBasis({ body: { answer: true } }).evidence).toBeUndefined();
  });

  it("null vs absent are the same answer, so a null Accept still keeps evidence", () => {
    const nullPrior = { ...agent, answer: null };
    expect(acceptedBasis({ prior: nullPrior, body: { answer: null } }).evidence).toHaveLength(1);
    // and an explicit null over a non-null prior is a CHANGE
    expect(acceptedBasis({ prior: agent, body: { answer: null } }).evidence).toBeUndefined();
  });

  it("a re-Accept of an already-reviewer answer keeps what the first Accept kept", () => {
    const first = acceptedBasis({ prior: agent, body: { answer: "assessed_and_addressed" } });
    const second = acceptedBasis({
      prior: { answer: "assessed_and_addressed", ...first },
      body: { answer: "assessed_and_addressed" },
    });
    expect(second.evidence).toHaveLength(1);
  });
});

describe("endorsing the agent's answer inherits the agent's basis", () => {
  it("a FIRST Accept, with no prior entry at all, inherits and is stamped", () => {
    const out = acceptedBasis({ shadow: [agent], body: { answer: "assessed_and_addressed" } });
    expect(out.evidence).toHaveLength(1);
    expect(out.reasoning).toBe("problem list + plan");
    expect(out.evidence_from).toBe("agent_draft");
    // A model's calibrated score is not a human's certainty.
    expect(out.confidence).toBeUndefined();
  });

  it("an ALREADY-ERASED reviewer entry re-inherits — this is what repairs a validated gold", () => {
    // The exact session_130 shape: the reviewer entry holds the right answer with
    // `evidence: []`. An empty array is not a basis, it is the erasure, so it must
    // fall through to the shadow instead of carrying [] forward.
    const erased: QuestionAnswer = {
      question_id: "Q", tier: 1, answer: "assessed_and_addressed",
      evidence: [], source: "reviewer",
    };
    const out = acceptedBasis({ prior: erased, shadow: [agent], body: { answer: "assessed_and_addressed" } });
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence_from).toBe("agent_draft");
  });

  it("CHANGING the answer TO the agent's inherits it — the basis follows the value", () => {
    const out = acceptedBasis({
      prior: { answer: "not_assessed", evidence: [{ note_id: "n9", quote: "old" }] },
      shadow: [agent], body: { answer: "assessed_and_addressed" },
    });
    expect(out.evidence).toEqual([{ note_id: "n1", quote: "GERD" }]);
    expect(out.evidence_from).toBe("agent_draft");
  });

  it("an answer NEITHER agent gave inherits nothing", () => {
    const out = acceptedBasis({ shadow: [agent], body: { answer: "not_assessed" } });
    expect(out.evidence).toBeUndefined();
    expect(out.reasoning).toBeUndefined();
  });

  it("with two agents, the one that AGREES supplies the basis", () => {
    const a2: QuestionAnswer = {
      question_id: "Q", tier: 1, answer: "not_assessed", source: "agent",
      evidence: [{ note_id: "n7", quote: "other claim" }],
    };
    const out = acceptedBasis({ shadow: [a2, agent], body: { answer: "assessed_and_addressed" } });
    expect(out.evidence).toEqual([{ note_id: "n1", quote: "GERD" }]);
  });

  it("an agreeing agent WITHOUT quotes does not shadow one that has them", () => {
    const bare: QuestionAnswer = {
      question_id: "Q", tier: 1, answer: "assessed_and_addressed", source: "agent",
    };
    const out = acceptedBasis({ shadow: [bare, agent], body: { answer: "assessed_and_addressed" } });
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence_from).toBe("agent_draft");
  });

  it("a reviewer's OWN prior citations are never replaced by an agreeing agent's", () => {
    const mine: QuestionAnswer = {
      question_id: "Q", tier: 1, answer: "assessed_and_addressed", source: "reviewer",
      evidence: [{ note_id: "n5", quote: "what I actually read" }],
    };
    const out = acceptedBasis({ prior: mine, shadow: [agent], body: { answer: "assessed_and_addressed" } });
    expect(out.evidence).toEqual([{ note_id: "n5", quote: "what I actually read" }]);
    expect(out.evidence_from).toBeUndefined();
  });

  it("a re-Accept of an inherited basis stays stamped as inherited", () => {
    // Otherwise a second click would silently launder the agent's quotes into
    // the reviewer's own.
    const first = acceptedBasis({ shadow: [agent], body: { answer: "assessed_and_addressed" } });
    const second = acceptedBasis({
      prior: { answer: "assessed_and_addressed", ...first },
      shadow: [agent], body: { answer: "assessed_and_addressed" },
    });
    expect(second.evidence_from).toBe("agent_draft");
  });
});
