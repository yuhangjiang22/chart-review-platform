import { describe, it, expect } from "vitest";
import { iterStatsRecordContribution, type IterStatsReviewRecord } from "./pilots.js";

// Regression guard for FIX 1: pilotIterationStats reported n_imported:0 /
// n_overrides:0 for fully-validated NER + adherence iterations because the
// per-record counting baked in two phenotype-only assumptions:
//   (a) it gated `imported` on lock_task_sha === iter sha, but NER/adherence
//       review states carry lock_task_sha:null → every record skipped;
//   (b) it counted overrides only from field_assessments, which are [] for
//       the new kinds.
// These exercise the pure per-record helper across all three kinds.

const SHA = "abc123";

describe("iterStatsRecordContribution — phenotype (unchanged)", () => {
  it("imports only records pinned to THIS iter's sha", () => {
    const matched: IterStatsReviewRecord = { lock_task_sha: SHA, field_assessments: [] };
    const other: IterStatsReviewRecord = { lock_task_sha: "different", field_assessments: [] };
    expect(iterStatsRecordContribution(matched, SHA).imported).toBe(true);
    expect(iterStatsRecordContribution(other, SHA).imported).toBe(false);
  });

  it("counts reviewer overrides (overridden status or agent snapshot)", () => {
    const rec: IterStatsReviewRecord = {
      task_kind: "phenotype",
      lock_task_sha: SHA,
      field_assessments: [
        { source: "reviewer", status: "overridden" },
        { source: "reviewer", original_agent_snapshot: { answer: "x" } },
        { source: "reviewer", status: "approved" }, // not an override
        { source: "agent", status: "overridden" }, // not reviewer-sourced
      ],
    };
    expect(iterStatsRecordContribution(rec, SHA)).toEqual({ imported: true, overrides: 2 });
  });
});

describe("iterStatsRecordContribution — NER", () => {
  it("imports a record with spans WITHOUT gating on lock_task_sha", () => {
    // The live fixture shape: 56 mapped spans, lock_task_sha absent, 7 validated_notes.
    const rec: IterStatsReviewRecord = {
      task_kind: "ner",
      span_labels: Array.from({ length: 56 }, () => ({ status: "mapped" })),
      validated_notes: ["n1", "n2", "n3", "n4", "n5", "n6", "n7"],
    };
    const c = iterStatsRecordContribution(rec, SHA);
    expect(c.imported).toBe(true); // the MUST-FIX symptom: was false (n_imported:0)
    expect(c.overrides).toBe(1); // validated_notes present → reviewer activity
  });

  it("a span-only record with no reviewer activity imports but no override", () => {
    const rec: IterStatsReviewRecord = {
      task_kind: "ner",
      span_labels: [{ status: "mapped" }],
    };
    expect(iterStatsRecordContribution(rec, SHA)).toEqual({ imported: true, overrides: 0 });
  });

  it("a rejected span counts as reviewer activity even without validated_notes", () => {
    const rec: IterStatsReviewRecord = {
      task_kind: "ner",
      span_labels: [{ status: "mapped" }, { status: "rejected" }],
    };
    expect(iterStatsRecordContribution(rec, SHA)).toEqual({ imported: true, overrides: 1 });
  });

  it("zero spans → not imported", () => {
    const rec: IterStatsReviewRecord = { task_kind: "ner", span_labels: [] };
    expect(iterStatsRecordContribution(rec, SHA)).toEqual({ imported: false, overrides: 0 });
  });
});

describe("iterStatsRecordContribution — adherence", () => {
  it("imports a record with question_answers WITHOUT gating on lock_task_sha", () => {
    const rec: IterStatsReviewRecord = {
      task_kind: "adherence",
      question_answers: [{ source: "agent" }, { source: "reviewer" }],
      rule_verdicts: [{ source: "rule_engine" }],
    };
    const c = iterStatsRecordContribution(rec, SHA);
    expect(c.imported).toBe(true);
    expect(c.overrides).toBe(1); // a reviewer-sourced answer present
  });

  it("imports on rule_verdicts alone", () => {
    const rec: IterStatsReviewRecord = {
      task_kind: "adherence",
      rule_verdicts: [{ source: "rule_engine" }],
    };
    expect(iterStatsRecordContribution(rec, SHA)).toEqual({ imported: true, overrides: 0 });
  });

  it("no answers and no verdicts → not imported", () => {
    const rec: IterStatsReviewRecord = { task_kind: "adherence" };
    expect(iterStatsRecordContribution(rec, SHA)).toEqual({ imported: false, overrides: 0 });
  });
});
