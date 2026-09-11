import { describe, it, expect } from "vitest";

// A PROMOTED BUT INCOMPLETE DRAFT MUST NOT REPORT AS A CLEAN RUN.
//
// The gap is model-independent and predates any model change; it is only
// exposed by whichever model happens to stop early. Two shapes seen:
//
//   no write calls at all   the model spends its budget reasoning and returns
//                           without touching a write tool. Already caught —
//                           classifyAgentOutcome fails an agent with zero
//                           writes, so the patient fails rather than saving an
//                           empty draft.
//   partial writes          the model writes some answers, calls
//                           set_review_status, and reports "Completed chart
//                           review". Measured: 8 of 14 period answers, 6 rules
//                           left unjudged. The platform named those 6 in the
//                           transcript and the run still said complete with
//                           zero errors — indistinguishable from a full round.
//
// These tests pin the SECOND shape's accounting: the draft survives (it is real
// work, and its citations already passed the faithfulness gate) while the run
// stops claiming it is clean.

/** The run-state mapping from `startBatchRun`'s finaliser (runs.ts). */
const runState = (nComplete: number, nError: number) =>
  nComplete === 0 && nError > 0 ? "failed" : nError > 0 ? "complete_with_errors" : "complete";

/** The driver's per-patient accounting, including the incomplete branch. */
function tally(patients: Array<{
  patient_status: "complete" | "complete_with_errors" | "failed";
  incomplete_rules?: string[];
}>) {
  let nComplete = 0, nError = 0;
  for (const p of patients) {
    if (p.patient_status !== "failed") nComplete += 1;
    if (p.patient_status !== "complete") nError += 1;
    else if (p.incomplete_rules?.length) nError += 1;
  }
  return { nComplete, nError, state: runState(nComplete, nError) };
}

describe("an incomplete draft counts against the run", () => {
  it("a complete patient with unjudged rules makes the run complete_with_errors", () => {
    const t = tally([{ patient_status: "complete", incomplete_rules: ["R-A", "R-B"] }]);
    expect(t.state).toBe("complete_with_errors");
    // The patient still counts as done: the draft was promoted and is usable.
    expect(t.nComplete).toBe(1);
  });

  it("a fully answered patient still reports clean", () => {
    expect(tally([{ patient_status: "complete" }]).state).toBe("complete");
  });

  it("an empty incomplete_rules array is not an error", () => {
    // Absent and empty must behave alike — the field is omitted when there is
    // nothing to report, and a stray [] must not manufacture a failure.
    expect(tally([{ patient_status: "complete", incomplete_rules: [] }]).state).toBe("complete");
  });

  it("does not double-count a patient that already errored", () => {
    // `complete_with_errors` already incremented n_error; the incomplete branch
    // is `else if` so the same patient cannot count twice.
    const t = tally([{ patient_status: "complete_with_errors", incomplete_rules: ["R-A"] }]);
    expect(t.nError).toBe(1);
  });

  it("one incomplete patient among many marks the whole run", () => {
    const t = tally([
      { patient_status: "complete" },
      { patient_status: "complete" },
      { patient_status: "complete", incomplete_rules: ["R-T1-SpirometryWithin24mo"] },
    ]);
    expect(t.state).toBe("complete_with_errors");
    expect(t.nError).toBe(1);
    expect(t.nComplete).toBe(3);
  });

  it("every patient incomplete is still not a failed run", () => {
    // `failed` means no draft was produced at all. Incomplete drafts exist and
    // can be reviewed, so the distinction has to survive.
    const t = tally([
      { patient_status: "complete", incomplete_rules: ["R-A"] },
      { patient_status: "complete", incomplete_rules: ["R-B"] },
    ]);
    expect(t.state).toBe("complete_with_errors");
  });
});
