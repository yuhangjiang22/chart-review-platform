import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { replayReviewerAnswers, computeKappaProper } from "../kappa.js";
import { appendAuditEntry } from "../audit-trail.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kappa-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

const TID = "t1";

/** Seed a ui_action with set_field_assessment using reviewer__<name> session_id convention. */
function seedUiAction(
  pid: string,
  reviewer: string,
  fieldId: string,
  answer: unknown,
  ts: string,
) {
  const sessionId = `reviewer__${reviewer}`;
  appendAuditEntry(
    { patientId: pid, taskId: TID, sessionId },
    {
      ts,
      session_id: sessionId,
      step_type: "ui_action",
      action_type: "set_field_assessment",
      source: "reviewer",
      payload_summary: `field_id=${fieldId} answer=${JSON.stringify(answer)}`,
      payload_field_id: fieldId,
      payload_answer: answer,
    } as never,
  );
}

describe("replayReviewerAnswers", () => {
  it("returns last-write-wins per (patient, reviewer, field)", () => {
    seedUiAction("p1", "alice", "x", "yes", "2026-04-29T10:00:00Z");
    seedUiAction("p1", "alice", "x", "no", "2026-04-29T11:00:00Z"); // alice changes mind
    seedUiAction("p1", "bob", "x", "yes", "2026-04-29T12:00:00Z");
    const out = replayReviewerAnswers(TMP, TID, "x");
    expect(out).toHaveLength(2);
    const alice = out.find((r) => r.reviewer_id === "alice");
    expect(alice?.answer).toBe("no"); // alice's last write wins
    expect(out.find((r) => r.reviewer_id === "bob")?.answer).toBe("yes");
  });

  it("ignores entries without payload_field_id (back-compat with older audit format)", () => {
    // Seed an older-format entry with no payload_field_id
    appendAuditEntry(
      { patientId: "p1", taskId: TID, sessionId: "reviewer__old" },
      {
        ts: "2026-04-29T09:00:00Z",
        session_id: "reviewer__old",
        step_type: "ui_action",
        action_type: "set_field_assessment",
        source: "reviewer",
        payload_summary: "field_id=x answer=yes",
        // no payload_field_id; older format
      } as never,
    );
    seedUiAction("p1", "alice", "x", "yes", "2026-04-29T10:00:00Z");
    const out = replayReviewerAnswers(TMP, TID, "x");
    expect(out).toHaveLength(1);
    expect(out[0].reviewer_id).toBe("alice");
  });

  it("ignores entries whose session_id cannot be disambiguated to a reviewer", () => {
    // A session_id that does NOT match reviewer__<name>
    appendAuditEntry(
      { patientId: "p1", taskId: TID, sessionId: "agent-session-42" },
      {
        ts: "2026-04-29T10:00:00Z",
        session_id: "agent-session-42",
        step_type: "ui_action",
        action_type: "set_field_assessment",
        source: "reviewer",
        payload_summary: "field_id=x answer=yes",
        payload_field_id: "x",
        payload_answer: "yes",
      } as never,
    );
    const out = replayReviewerAnswers(TMP, TID, "x");
    expect(out).toHaveLength(0);
  });

  it("only returns results for the requested fieldId", () => {
    seedUiAction("p1", "alice", "x", "yes", "2026-04-29T10:00:00Z");
    seedUiAction("p1", "alice", "y", "no", "2026-04-29T10:00:00Z");
    const out = replayReviewerAnswers(TMP, TID, "x");
    expect(out).toHaveLength(1);
    expect(out[0].field_id).toBe("x");
  });
});

describe("computeKappaProper", () => {
  it("returns null when fewer than 10 shared records", () => {
    const answers = [
      {
        patient_id: "p1",
        reviewer_id: "alice",
        field_id: "x",
        answer: "yes",
        ts: "2026-04-29T10:00Z",
      },
      {
        patient_id: "p1",
        reviewer_id: "bob",
        field_id: "x",
        answer: "yes",
        ts: "2026-04-29T11:00Z",
      },
    ];
    expect(computeKappaProper(answers)).toBe(null);
  });

  it("returns null when fewer than 2 reviewers", () => {
    const answers = Array.from({ length: 12 }, (_, i) => ({
      patient_id: `p${i}`,
      reviewer_id: "alice",
      field_id: "x",
      answer: "yes",
      ts: `2026-04-29T10:00:0${i}Z`,
    }));
    expect(computeKappaProper(answers)).toBe(null);
  });

  it("computes κ for 12 shared records with known agreement pattern (target ≈ 0.625)", () => {
    // alice: 8 yes / 4 no
    // bob:   8 yes / 4 no, with 10 agreements (7 yes-yes + 3 no-no, 2 disagreements)
    // Confusion: yes-yes=7, yes-no=1, no-yes=1, no-no=3
    // Po = 10/12 ≈ 0.8333
    // Pe = (8/12)*(8/12) + (4/12)*(4/12) = 64/144 + 16/144 ≈ 0.5556
    // κ = (0.8333 - 0.5556) / (1 - 0.5556) ≈ 0.625
    const aliceAnswers = [
      "yes", "yes", "yes", "yes", "yes", "yes", "yes", "yes",
      "no",  "no",  "no",  "no",
    ];
    //                                                         ^yes-no  ^no-yes (2 disagreements)
    const bobAnswers = [
      "yes", "yes", "yes", "yes", "yes", "yes", "yes", "no",
      "yes", "no",  "no",  "no",  // bob: 8 yes / 4 no; 7 yes-yes, 3 no-no, 1 yes-no, 1 no-yes
    ];
    const answers: Array<{
      patient_id: string;
      reviewer_id: string;
      field_id: string;
      answer: unknown;
      ts: string;
    }> = [];
    for (let i = 0; i < 12; i++) {
      answers.push({
        patient_id: `p${i}`,
        reviewer_id: "alice",
        field_id: "x",
        answer: aliceAnswers[i],
        ts: `2026-04-29T10:00:0${i}Z`,
      });
      answers.push({
        patient_id: `p${i}`,
        reviewer_id: "bob",
        field_id: "x",
        answer: bobAnswers[i],
        ts: `2026-04-29T11:00:0${i}Z`,
      });
    }
    const result = computeKappaProper(answers);
    expect(result).not.toBe(null);
    expect(result!.kappa).toBeCloseTo(0.625, 2);
    expect(result!.kappa_n_shared).toBe(12);
    expect(result!.kappa_reviewers.sort()).toEqual(["alice", "bob"]);
    // confusion matrix spot-check: alice=yes ∩ bob=yes = 7
    expect(result!.confusion["yes"]["yes"]).toBe(7);
    // alice=no ∩ bob=no = 3
    expect(result!.confusion["no"]["no"]).toBe(3);
    // alice=yes ∩ bob=no = 1 (one disagreement)
    expect(result!.confusion["yes"]["no"]).toBe(1);
    // alice=no ∩ bob=yes = 1 (one disagreement)
    expect(result!.confusion["no"]["yes"]).toBe(1);
  });

  it("returns κ = 1.0 when Pe = 1 (edge case: 1 - Pe == 0)", () => {
    // All answers the same category → Pe = 1 → denominator = 0 → κ = 1.0
    const answers = Array.from({ length: 10 }, (_, i) => [
      {
        patient_id: `p${i}`,
        reviewer_id: "alice",
        field_id: "x",
        answer: "yes",
        ts: `2026-04-29T10:00:0${i}Z`,
      },
      {
        patient_id: `p${i}`,
        reviewer_id: "bob",
        field_id: "x",
        answer: "yes",
        ts: `2026-04-29T11:00:0${i}Z`,
      },
    ]).flat();
    const result = computeKappaProper(answers);
    expect(result).not.toBe(null);
    expect(result!.kappa).toBe(1.0);
  });
});
