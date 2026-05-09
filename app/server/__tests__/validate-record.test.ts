/**
 * TDD tests for the /validate endpoint gate logic.
 *
 * We don't spin up Express here — we test the validation logic directly
 * by constructing ReviewState shapes and the CompiledTask, then calling
 * the same helper functions the route uses: loadReviewState (via `load`),
 * applyUiAction for set_review_status, and the gate predicates in isolation.
 *
 * Four test cases:
 *   POSITIVE — all gates pass → review_status flips to reviewer_validated
 *   NEGATIVE/terminal — one leaf is still pending → all_terminal fails
 *   NEGATIVE/alerts — an error-severity alert remains → alerts_dismissed fails
 *   NEGATIVE/touch — a leaf is still agent-sourced → every_leaf_touched fails
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { applyUiAction, load, loadOrCreate, type ReviewState } from "../domain/review/index.js";
import type { CompiledTask } from "../tasks.js";
import type { CrossCriterionAlert } from "../types.js";

// ── fixture helpers ───────────────────────────────────────────────────────────

let TMP: string;
const PID = "validate-pid";
const TID = "validate-tid";

/** Two-leaf, one-derived CompiledTask. Derivation field is excluded from gate. */
const TASK: CompiledTask = {
  task_id: TID,
  source_document_sha: "validate-sha",
  fields: [
    { id: "leaf_a" },
    { id: "leaf_b" },
    { id: "derived_c", derivation: "leaf_a == 'yes' && leaf_b == 'yes'" },
  ],
};

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "validate-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

/** Load the persisted review state, throwing if not found. */
function readState(): ReviewState {
  const s = load(PID, TID);
  if (!s) throw new Error("state file not found");
  return s;
}

/**
 * Inject cross_criterion_alerts directly into the persisted JSON.
 * Used to simulate the live-alerts recomputation having found errors.
 */
function injectAlerts(alerts: CrossCriterionAlert[]): void {
  const stateDir = path.join(TMP, PID, TID);
  const stateFile = path.join(stateDir, "review_state.json");
  const s = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as ReviewState;
  s.cross_criterion_alerts = alerts;
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2) + "\n");
}

/**
 * Run the same gate logic the /validate endpoint uses.
 * Returns { all_terminal, every_leaf_touched_or_bulk_accepted,
 *            alerts_dismissed, faithfulness_pass, all_passed }.
 */
function runValidateGate(state: ReviewState) {
  const leafFields = TASK.fields.filter((f) => !f.derivation);

  const all_terminal = leafFields.every((f) => {
    const fa = state.field_assessments.find((x) => x.field_id === f.id);
    return (
      fa &&
      (fa.status === "approved" ||
        fa.status === "overridden" ||
        fa.status === "not_applicable")
    );
  });

  const every_leaf_touched_or_bulk_accepted = leafFields.every((f) => {
    const fa = state.field_assessments.find((x) => x.field_id === f.id);
    return fa && fa.source === "reviewer";
  });

  const alerts_dismissed = !(state.cross_criterion_alerts ?? []).some(
    (a) => a.severity === "error",
  );

  const faithfulness_pass = true; // enforced at write time

  const all_passed =
    all_terminal &&
    every_leaf_touched_or_bulk_accepted &&
    alerts_dismissed &&
    faithfulness_pass;

  return {
    all_terminal,
    every_leaf_touched_or_bulk_accepted,
    alerts_dismissed,
    faithfulness_pass,
    all_passed,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("validate gate — POSITIVE", () => {
  it("all gates pass → all_passed true and review_status flips to reviewer_validated", () => {
    // Establish state: both leaves approved by reviewer, no alerts.
    loadOrCreate(PID, TASK); // initialise file
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_field_assessment",
      payload: { field_id: "leaf_a", answer: "yes", status: "approved" },
    });
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_field_assessment",
      payload: { field_id: "leaf_b", answer: "yes", status: "approved" },
    });

    const state = readState();
    const gates = runValidateGate(state);

    expect(gates.all_terminal).toBe(true);
    expect(gates.every_leaf_touched_or_bulk_accepted).toBe(true);
    expect(gates.alerts_dismissed).toBe(true);
    expect(gates.faithfulness_pass).toBe(true);
    expect(gates.all_passed).toBe(true);

    // If all_passed, the route flips review_status via set_review_status.
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "reviewer_validated", updated_by: "alice" },
    });

    const final = readState();
    expect(final.review_status).toBe("reviewer_validated");
  });
});

describe("validate gate — NEGATIVE: pending leaf", () => {
  it("one leaf still pending → all_terminal false, all_passed false", () => {
    loadOrCreate(PID, TASK);
    // Only approve leaf_a; leaf_b stays pending (no assessment written).
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_field_assessment",
      payload: { field_id: "leaf_a", answer: "yes", status: "approved" },
    });

    const state = readState();
    const gates = runValidateGate(state);

    expect(gates.all_terminal).toBe(false);
    expect(gates.all_passed).toBe(false);
  });
});

describe("validate gate — NEGATIVE: error alert present", () => {
  it("error-severity alert → alerts_dismissed false, all_passed false", () => {
    loadOrCreate(PID, TASK);
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_field_assessment",
      payload: { field_id: "leaf_a", answer: "yes", status: "approved" },
    });
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_field_assessment",
      payload: { field_id: "leaf_b", answer: "yes", status: "approved" },
    });

    // Inject an error-severity alert directly (simulating live-alerts engine).
    injectAlerts([
      {
        id: "alert-1",
        kind: "derivation_violation",
        fields: ["derived_c"],
        severity: "error",
        message: "derivation mismatch",
        computed_at: new Date().toISOString(),
        source: "live",
      },
    ]);

    const state = readState();
    const gates = runValidateGate(state);

    expect(gates.alerts_dismissed).toBe(false);
    expect(gates.all_passed).toBe(false);

    // A warning-severity alert does NOT block validation.
    injectAlerts([
      {
        id: "alert-2",
        kind: "applicability_violation",
        fields: ["leaf_b"],
        severity: "warning",
        message: "leaf_b may not be applicable",
        computed_at: new Date().toISOString(),
        source: "live",
      },
    ]);
    const state2 = readState();
    const gates2 = runValidateGate(state2);
    expect(gates2.alerts_dismissed).toBe(true);
  });
});

describe("validate gate — NEGATIVE: reviewer has not touched all leaves", () => {
  it("one leaf still agent-sourced → every_leaf_touched false, all_passed false", () => {
    loadOrCreate(PID, TASK);
    // Agent proposes leaf_a; reviewer only touches leaf_b.
    applyUiAction(PID, TASK, "agent", "agent-session", {
      type: "set_field_assessment",
      payload: { field_id: "leaf_a", answer: "yes", status: "agent_proposed" },
    });
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_field_assessment",
      payload: { field_id: "leaf_b", answer: "no", status: "approved" },
    });

    const state = readState();
    const gates = runValidateGate(state);

    // leaf_a is agent_proposed with source=agent → not terminal yet
    expect(gates.all_terminal).toBe(false);
    expect(gates.every_leaf_touched_or_bulk_accepted).toBe(false);
    expect(gates.all_passed).toBe(false);
  });

  it("bulk-accept pattern: agent proposes then reviewer approves all → every_leaf_touched true", () => {
    loadOrCreate(PID, TASK);
    // Agent proposes both leaves.
    applyUiAction(PID, TASK, "agent", "agent-session", {
      type: "set_field_assessment",
      payload: { field_id: "leaf_a", answer: "yes", status: "agent_proposed" },
    });
    applyUiAction(PID, TASK, "agent", "agent-session", {
      type: "set_field_assessment",
      payload: { field_id: "leaf_b", answer: "no", status: "agent_proposed" },
    });

    // Reviewer bulk-accepts (promotes all to source=reviewer).
    const preState = readState();
    const agentTargets = preState.field_assessments.filter((f) => f.source === "agent");
    for (const fa of agentTargets) {
      applyUiAction(PID, TASK, "reviewer", "alice", {
        type: "set_field_assessment",
        payload: {
          field_id: fa.field_id,
          answer: fa.answer,
          confidence: fa.confidence,
          evidence: fa.evidence,
          rationale: fa.rationale,
          status: "approved",
        },
      });
    }

    const state = readState();
    const gates = runValidateGate(state);

    expect(gates.all_terminal).toBe(true);
    expect(gates.every_leaf_touched_or_bulk_accepted).toBe(true);
    expect(gates.all_passed).toBe(true);
  });
});

describe("set_review_status UiAction", () => {
  it("transitions review_status to any valid target value", () => {
    loadOrCreate(PID, TASK);
    // Start: draft → in_progress (via a field assessment)
    applyUiAction(PID, TASK, "agent", "agent-1", {
      type: "set_field_assessment",
      payload: { field_id: "leaf_a", answer: "yes", status: "agent_proposed" },
    });

    // Transition: directly to reviewer_validated
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "reviewer_validated", updated_by: "alice" },
    });

    expect(readState().review_status).toBe("reviewer_validated");

    // Transition: to locked
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "locked", updated_by: "alice" },
    });

    expect(readState().review_status).toBe("locked");
  });
});
