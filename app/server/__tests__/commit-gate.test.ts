/**
 * Tests for the A1 commit gate: checkCommitGate() in mcp-tools.ts.
 *
 * Three cases:
 *   1. Incomplete review (3 of 4 criteria committed) → error with missing_criteria list.
 *   2. Complete review (all 4 criteria committed) → null (no error).
 *   3. Gated criterion (is_applicable_when evaluates to not_applicable) → exempt,
 *      call succeeds even without an assessment for that criterion.
 */

import { describe, it, expect } from "vitest";
import { checkCommitGate } from "../mcp-tools.js";
import type { CompiledTask } from "../tasks.js";
import type { ReviewState } from "../domain/review/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(fieldAssessments: Array<{ field_id: string; answer?: unknown }>): ReviewState {
  return {
    schema_version: "1",
    patient_id: "p1",
    task_id: "t1",
    review_status: "in_progress",
    version: 5,
    updated_at: new Date().toISOString(),
    updated_by: "agent",
    field_assessments: fieldAssessments.map((fa) => ({
      field_id: fa.field_id,
      answer: fa.answer ?? "yes",
      source: "agent" as const,
      status: "agent_proposed" as const,
      updated_at: new Date().toISOString(),
      updated_by: "agent-session-1",
    })),
  };
}

// ── Task fixtures ─────────────────────────────────────────────────────────────

/** 4-criterion task: 3 leaf criteria + 1 derived. */
const TASK_4_FIELDS: CompiledTask = {
  task_id: "t1",
  source_document_sha: "sha-abc",
  fields: [
    { id: "criterion_a" },
    { id: "criterion_b" },
    { id: "criterion_c" },
    { id: "derived_d", derivation: "criterion_a == 'yes' AND criterion_b == 'yes'" },
  ],
};

/** 4-criterion task with one gated field. */
const TASK_WITH_GATE: CompiledTask = {
  task_id: "t1",
  source_document_sha: "sha-gate",
  fields: [
    { id: "something_else" },
    { id: "criterion_b" },
    { id: "criterion_c" },
    { id: "gated_criterion", is_applicable_when: "something_else == 'yes'" },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkCommitGate", () => {
  describe("incomplete review", () => {
    it("returns missing_criteria when 3 of 4 leaf criteria have no assessment", () => {
      // Only criterion_a is committed; criterion_b and criterion_c are missing.
      // derived_d is a derivation — not counted.
      const state = makeState([{ field_id: "criterion_a", answer: "yes" }]);
      const result = checkCommitGate(TASK_4_FIELDS, state);

      expect(result).not.toBeNull();
      expect(result!.missing_criteria).toContain("criterion_b");
      expect(result!.missing_criteria).toContain("criterion_c");
      // Derived field must NOT appear in missing list
      expect(result!.missing_criteria).not.toContain("derived_d");
    });

    it("includes the exact missing field_ids in the error list", () => {
      // criterion_a and criterion_b committed; criterion_c missing.
      const state = makeState([
        { field_id: "criterion_a", answer: "yes" },
        { field_id: "criterion_b", answer: "no" },
      ]);
      const result = checkCommitGate(TASK_4_FIELDS, state);

      expect(result).not.toBeNull();
      expect(result!.missing_criteria).toEqual(["criterion_c"]);
    });
  });

  describe("complete review", () => {
    it("returns null when all non-derived criteria have assessments", () => {
      const state = makeState([
        { field_id: "criterion_a", answer: "yes" },
        { field_id: "criterion_b", answer: "no" },
        { field_id: "criterion_c", answer: "no_info" },
      ]);
      // derived_d has no assessment but is derived — should be exempt.
      const result = checkCommitGate(TASK_4_FIELDS, state);
      expect(result).toBeNull();
    });

    it("returns null when answer is no_info (a valid committed value)", () => {
      const state = makeState([
        { field_id: "criterion_a", answer: "no_info" },
        { field_id: "criterion_b", answer: "not_applicable" },
        { field_id: "criterion_c", answer: false },
      ]);
      const result = checkCommitGate(TASK_4_FIELDS, state);
      expect(result).toBeNull();
    });
  });

  describe("is_applicable_when gate", () => {
    it("exempts a gated criterion when the gate evaluates to not_applicable", () => {
      // something_else = 'no' → gated_criterion is_applicable_when 'something_else == "yes"'
      // evaluates to not_applicable → gated_criterion is exempt.
      const state = makeState([
        { field_id: "something_else", answer: "no" },
        { field_id: "criterion_b", answer: "yes" },
        { field_id: "criterion_c", answer: "yes" },
        // gated_criterion has NO assessment — but the gate is off.
      ]);
      const result = checkCommitGate(TASK_WITH_GATE, state);
      expect(result).toBeNull();
    });

    it("requires a gated criterion when the gate evaluates to applicable", () => {
      // something_else = 'yes' → gated_criterion gate is applicable → must be assessed.
      const state = makeState([
        { field_id: "something_else", answer: "yes" },
        { field_id: "criterion_b", answer: "yes" },
        { field_id: "criterion_c", answer: "yes" },
        // gated_criterion is missing — should be flagged.
      ]);
      const result = checkCommitGate(TASK_WITH_GATE, state);
      expect(result).not.toBeNull();
      expect(result!.missing_criteria).toContain("gated_criterion");
    });

    it("succeeds when the gated criterion is also assessed (gate=applicable)", () => {
      const state = makeState([
        { field_id: "something_else", answer: "yes" },
        { field_id: "criterion_b", answer: "yes" },
        { field_id: "criterion_c", answer: "yes" },
        { field_id: "gated_criterion", answer: "yes" },
      ]);
      const result = checkCommitGate(TASK_WITH_GATE, state);
      expect(result).toBeNull();
    });
  });
});
