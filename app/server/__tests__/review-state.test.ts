/**
 * TDD tests for the original_agent_snapshot capture predicate in
 * applySetAssessment.  Three branches (spec §5.5):
 *
 *   (a) reviewer overrides agent answer → snapshot captured from prior agent assessment
 *   (b) second reviewer override does NOT re-capture (sticky)
 *   (c) reviewer is the very first writer → no snapshot
 *
 * REVIEWS_ROOT injection: review-state.ts now reads the env var lazily on
 * every call to reviewDir(), so we can set process.env before calling
 * without needing vi.resetModules().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  applySetAssessment,
  applyUiAction,
  load,
  transitionReviewState,
  verifyFaithfulnessForAction,
  recomputeAlerts,
  ReviewStateError,
} from "../domain/review/index.js";
import type { ReviewState, UiAction } from "../domain/review/index.js";
import type { CompiledTask } from "../tasks.js";

// ── helpers ──────────────────────────────────────────────────────────────────

let TMP: string;
const PID = "p1";
const TID = "t1";

/** Minimal compiled task that has a single field "x". */
const TASK: CompiledTask = {
  task_id: TID,
  source_document_sha: "test-sha",
  fields: [{ id: "x" }],
};

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rs-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

function readState() {
  const state = load(PID, TID);
  if (!state) throw new Error("state file not found");
  return state;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("original_agent_snapshot capture predicate", () => {
  it("(a) reviewer overrides → snapshot captured from prior agent answer", () => {
    // Step 1: agent proposes an answer
    applySetAssessment(PID, TASK, "agent", "agent-session-1", {
      field_id: "x",
      answer: "yes",
      confidence: "high",
      status: "agent_proposed",
    });

    // Step 2: reviewer overrides
    applySetAssessment(PID, TASK, "reviewer", "alice", {
      field_id: "x",
      answer: "no",
      status: "overridden",
      edit_reason: "missed_evidence",
    });

    const s = readState();
    const fa = s.field_assessments.find((f) => f.field_id === "x");
    expect(fa).toBeDefined();
    expect(fa!.original_agent_snapshot).toBeTruthy();
    expect(fa!.original_agent_snapshot!.answer).toBe("yes");
    expect(fa!.original_agent_snapshot!.confidence).toBe("high");
    // captured_at must be a valid ISO string
    expect(Date.parse(fa!.original_agent_snapshot!.captured_at)).toBeGreaterThan(0);
    // captured_from_version is a positive integer
    expect(fa!.original_agent_snapshot!.captured_from_version).toBeGreaterThan(0);
  });

  it("(b) second reviewer override does NOT re-capture snapshot", () => {
    // Step 1: agent
    applySetAssessment(PID, TASK, "agent", "agent", {
      field_id: "x",
      answer: "yes",
      status: "agent_proposed",
    });

    // Step 2: first reviewer override — captures snapshot
    applySetAssessment(PID, TASK, "reviewer", "alice", {
      field_id: "x",
      answer: "no",
      status: "overridden",
      edit_reason: "missed_evidence",
    });

    // Step 3: second reviewer override — snapshot must NOT change
    applySetAssessment(PID, TASK, "reviewer", "alice", {
      field_id: "x",
      answer: "maybe",
      status: "overridden",
    });

    const fa = readState().field_assessments.find((f) => f.field_id === "x");
    // Current answer is the latest override
    expect(fa!.answer).toBe("maybe");
    // But snapshot still holds the ORIGINAL agent answer "yes", not "no"
    expect(fa!.original_agent_snapshot).toBeTruthy();
    expect(fa!.original_agent_snapshot!.answer).toBe("yes");
  });

  it("(c) reviewer is the very first writer → no snapshot", () => {
    applySetAssessment(PID, TASK, "reviewer", "alice", {
      field_id: "x",
      answer: "yes",
      status: "approved",
    });

    const fa = readState().field_assessments.find((f) => f.field_id === "x");
    expect(fa).toBeDefined();
    expect(fa!.original_agent_snapshot).toBeUndefined();
  });

  it("(d) agent re-asserts after reviewer override → snapshot stays sticky", () => {
    // Step 1: agent proposes "yes"
    applySetAssessment(PID, TASK, "agent", "agent-session-1", {
      field_id: "x",
      answer: "yes",
      confidence: "high",
      status: "agent_proposed",
    });

    // Step 2: reviewer overrides to "no" — captures snapshot from agent's "yes"
    applySetAssessment(PID, TASK, "reviewer", "alice", {
      field_id: "x",
      answer: "no",
      status: "overridden",
      edit_reason: "missed_evidence",
    });

    // Step 3: agent re-asserts its original "yes"
    applySetAssessment(PID, TASK, "agent", "agent-session-2", {
      field_id: "x",
      answer: "yes",
      confidence: "high",
      status: "agent_proposed",
    });

    const fa = readState().field_assessments.find((f) => f.field_id === "x");
    expect(fa).toBeDefined();
    // Current source is agent (most recent writer)
    expect(fa!.source).toBe("agent");
    // Current answer is the agent's re-assertion
    expect(fa!.answer).toBe("yes");
    // But snapshot still holds the ORIGINAL agent answer "yes" (not re-captured)
    // and was captured from the initial agent's version
    expect(fa!.original_agent_snapshot).toBeTruthy();
    expect(fa!.original_agent_snapshot!.answer).toBe("yes");
    expect(fa!.original_agent_snapshot!.confidence).toBe("high");
    expect(Date.parse(fa!.original_agent_snapshot!.captured_at)).toBeGreaterThan(0);
    expect(fa!.original_agent_snapshot!.captured_from_version).toBeGreaterThan(0);
  });
});

// ── Task 20: live-alerts wiring ───────────────────────────────────────────────

/**
 * Task that has a gated field "b" (only applicable when a == 'yes').
 * Setting b with an answer when a == 'no' should produce an
 * applicability_violation in cross_criterion_alerts.
 */
const GATED_TASK: CompiledTask = {
  task_id: "t1",
  source_document_sha: "gated-sha",
  fields: [
    { id: "a" },
    { id: "b", is_applicable_when: "a == 'yes'" },
  ],
};

describe("live-alerts wiring", () => {
  it("after applyUiAction(set_field_assessment), cross_criterion_alerts is recomputed and persisted", () => {
    // First: set "a" to "no" so the gate for "b" is false.
    applyUiAction(PID, GATED_TASK, "agent", "agent-1", {
      type: "set_field_assessment",
      payload: { field_id: "a", answer: "no", status: "agent_proposed" },
    });

    // Then: set "b" with an answer — this violates the is_applicable_when gate.
    applyUiAction(PID, GATED_TASK, "agent", "agent-1", {
      type: "set_field_assessment",
      payload: { field_id: "b", answer: "yes", status: "agent_proposed" },
    });

    // Read the persisted state and verify an applicability_violation was recorded.
    const s = readState();
    expect(s.cross_criterion_alerts).toBeDefined();
    expect(s.cross_criterion_alerts!.length).toBeGreaterThan(0);
    const violation = s.cross_criterion_alerts!.find(
      (a) => a.kind === "applicability_violation" && a.fields.includes("b"),
    );
    expect(violation).toBeDefined();
    expect(violation!.severity).toBe("warning");
  });

  it("cross_criterion_alerts is empty after a consistent state mutation", () => {
    // Set "a" to "yes" so the gate for "b" is satisfied, then set "b".
    applyUiAction(PID, GATED_TASK, "agent", "agent-1", {
      type: "set_field_assessment",
      payload: { field_id: "a", answer: "yes", status: "agent_proposed" },
    });
    applyUiAction(PID, GATED_TASK, "agent", "agent-1", {
      type: "set_field_assessment",
      payload: { field_id: "b", answer: "yes", status: "agent_proposed" },
    });

    const s = readState();
    expect(s.cross_criterion_alerts).toBeDefined();
    expect(s.cross_criterion_alerts).toHaveLength(0);
  });

  it("recomputation runs for set_summary action too (all UiAction variants trigger it)", () => {
    // Prime a violation: a=no, b=yes
    applyUiAction(PID, GATED_TASK, "agent", "agent-1", {
      type: "set_field_assessment",
      payload: { field_id: "a", answer: "no", status: "agent_proposed" },
    });
    applyUiAction(PID, GATED_TASK, "agent", "agent-1", {
      type: "set_field_assessment",
      payload: { field_id: "b", answer: "yes", status: "agent_proposed" },
    });

    // Now fire a set_summary action — alerts should still reflect the existing violation.
    const { state } = applyUiAction(PID, GATED_TASK, "reviewer", "alice", {
      type: "set_summary",
      payload: { brief_summary: "test summary" },
    });

    expect(state.cross_criterion_alerts).toBeDefined();
    expect(state.cross_criterion_alerts!.length).toBeGreaterThan(0);
    const violation = state.cross_criterion_alerts!.find(
      (a) => a.kind === "applicability_violation",
    );
    expect(violation).toBeDefined();
  });
});

// ── Phase R3: pure transition core ──────────────────────────────────────────

/**
 * These tests drive transitionReviewState directly with a synthesised input
 * state. There is NO filesystem fixture, NO audit append, NO drift check —
 * the whole point of the pure core is that you can call it with a literal
 * state object and assert on the literal returned state.
 */

const TASK_PURE: CompiledTask = {
  task_id: "pure-task",
  source_document_sha: "sha-pure",
  fields: [{ id: "x" }, { id: "y" }],
};

function emptyState(): ReviewState {
  return {
    schema_version: "1",
    patient_id: "pid-pure",
    task_id: "pure-task",
    review_status: "draft",
    version: 1,
    updated_at: "2025-01-01T00:00:00.000Z",
    updated_by: "system",
    field_assessments: [],
  };
}

describe("transitionReviewState — pure core", () => {
  it("set_field_assessment by agent stamps source=agent and bumps version", () => {
    const before = emptyState();
    const action: UiAction = {
      type: "set_field_assessment",
      payload: { field_id: "x", answer: "yes", confidence: "high" },
    };

    const { state } = transitionReviewState(before, TASK_PURE, "agent", "agent-1", action);

    // Caller's state untouched (purity).
    expect(before.version).toBe(1);
    expect(before.field_assessments).toHaveLength(0);
    // New state has the assessment.
    expect(state.version).toBe(2);
    expect(state.field_assessments).toHaveLength(1);
    expect(state.field_assessments[0].field_id).toBe("x");
    expect(state.field_assessments[0].answer).toBe("yes");
    expect(state.field_assessments[0].source).toBe("agent");
    expect(state.field_assessments[0].status).toBe("agent_proposed");
    expect(state.review_status).toBe("in_progress");
    expect(state.updated_by).toBe("agent");
  });

  it("set_field_assessment by reviewer over an agent answer captures snapshot", () => {
    const before: ReviewState = {
      ...emptyState(),
      version: 5,
      field_assessments: [
        {
          field_id: "x",
          answer: "yes",
          confidence: "high",
          source: "agent",
          status: "agent_proposed",
          updated_at: "2025-01-01T00:00:00.000Z",
          updated_by: "agent-1",
        },
      ],
    };
    const action: UiAction = {
      type: "set_field_assessment",
      payload: { field_id: "x", answer: "no", edit_reason: "missed_evidence" },
    };

    const { state } = transitionReviewState(before, TASK_PURE, "reviewer", "alice", action);

    const fa = state.field_assessments.find((f) => f.field_id === "x")!;
    expect(fa.answer).toBe("no");
    expect(fa.source).toBe("reviewer");
    expect(fa.status).toBe("overridden");
    expect(fa.original_agent_snapshot).toBeTruthy();
    expect(fa.original_agent_snapshot!.answer).toBe("yes");
    expect(fa.original_agent_snapshot!.captured_from_version).toBe(5);
  });

  it("set_review_status to 'locked' carries lock metadata into the new state", () => {
    const before: ReviewState = {
      ...emptyState(),
      review_status: "reviewer_validated",
      version: 7,
    };
    const action: UiAction = {
      type: "set_review_status",
      payload: {
        review_status: "locked",
        locked_at: "2025-02-02T12:00:00.000Z",
        locked_by: "alice",
        lock_task_sha: "abc123",
      },
    };

    const { state } = transitionReviewState(before, TASK_PURE, "reviewer", "alice", action);

    expect(state.review_status).toBe("locked");
    expect(state.locked_at).toBe("2025-02-02T12:00:00.000Z");
    expect(state.locked_by).toBe("alice");
    expect(state.lock_task_sha).toBe("abc123");
    expect(state.version).toBe(8);
  });

  it("recompute_alerts inside the transition produces an applicability_violation", () => {
    const gatedTask: CompiledTask = {
      task_id: "gated",
      source_document_sha: "g",
      fields: [
        { id: "a" },
        { id: "b", is_applicable_when: "a == 'yes'" },
      ],
    };
    const before: ReviewState = {
      ...emptyState(),
      task_id: "gated",
      field_assessments: [
        {
          field_id: "a",
          answer: "no",
          source: "agent",
          status: "agent_proposed",
          updated_at: "2025-01-01T00:00:00.000Z",
          updated_by: "agent-1",
        },
      ],
    };
    const action: UiAction = {
      type: "set_field_assessment",
      payload: { field_id: "b", answer: "yes" },
    };

    const { state } = transitionReviewState(before, gatedTask, "agent", "agent-1", action);

    expect(state.cross_criterion_alerts).toBeDefined();
    const violation = state.cross_criterion_alerts!.find(
      (alert) => alert.kind === "applicability_violation" && alert.fields.includes("b"),
    );
    expect(violation).toBeDefined();
  });

  it("add_encounter pushes a new encounter and returns its id", () => {
    const before = emptyState();
    const action: UiAction = {
      type: "add_encounter",
      payload: { kind: "encounter", date: "2024-08-22", label: "oncology consult" },
    };

    const { state, added_encounter_id } = transitionReviewState(
      before,
      TASK_PURE,
      "reviewer",
      "alice",
      action,
    );

    expect(added_encounter_id).toBeTruthy();
    expect(state.encounters).toHaveLength(1);
    expect(state.encounters![0].encounter_id).toBe(added_encounter_id);
    expect(state.encounters![0].label).toBe("oncology consult");
    // Caller's state untouched.
    expect(before.encounters).toBeUndefined();
  });

  it("unknown field_id throws unknown_field without mutating state", () => {
    const before = emptyState();
    const action: UiAction = {
      type: "set_field_assessment",
      payload: { field_id: "does-not-exist", answer: "yes" },
    };

    expect(() => transitionReviewState(before, TASK_PURE, "agent", "agent-1", action)).toThrow(
      ReviewStateError,
    );
    // Pure: caller state still pristine.
    expect(before.version).toBe(1);
    expect(before.field_assessments).toHaveLength(0);
  });

  it("set_summary preserves updated_by author and bumps version", () => {
    const before = emptyState();
    const action: UiAction = {
      type: "set_summary",
      payload: { brief_summary: "tiny summary", key_conditions: ["lung-ca"] },
    };

    const { state } = transitionReviewState(before, TASK_PURE, "reviewer", "alice", action);

    expect(state.summary).toBeDefined();
    expect(state.summary!.brief_summary).toBe("tiny summary");
    expect(state.summary!.updated_by).toBe("alice");
    expect(state.review_status).toBe("in_progress");
    expect(state.version).toBe(2);
  });
});

// ── Phase R3: side-effect helpers (no FS dependence) ────────────────────────

describe("verifyFaithfulnessForAction — pure gate", () => {
  it("passes through actions that carry no note evidence", () => {
    const action: UiAction = {
      type: "set_summary",
      payload: { brief_summary: "no evidence here" },
    };
    const warnings = verifyFaithfulnessForAction("any-pid", action);
    expect(warnings).toEqual([]);
  });
});

describe("recomputeAlerts — pure derivation", () => {
  it("clears alerts when state is consistent with the task", () => {
    const state: ReviewState = {
      ...emptyState(),
      cross_criterion_alerts: [],
    };
    recomputeAlerts(TASK_PURE, state);
    expect(state.cross_criterion_alerts).toEqual([]);
  });
});

