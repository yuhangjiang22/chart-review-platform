// app/server/__tests__/iter-phase.test.ts
//
// Tests for derivePhase — the single source of truth for an Iter's canonical
// lifecycle phase, computed from the today-scattered fields (state,
// auto_critique_state, run_status). The mapping is load-bearing for the UI
// and analytics; if it drifts, the iter_015-style debugging headache returns.

import { describe, it, expect } from "vitest";
import {
  derivePhase,
  transitionPhase,
  type PilotState,
  type PilotManifest,
} from "../domain/iter/index.js";

function manifest(state: PilotState, autoCritique?: "running" | "failed") {
  return { state, auto_critique_state: autoCritique };
}

/** Build a minimum-viable PilotManifest for transitionPhase tests. */
function fullManifest(
  state: PilotState,
  autoCritique?: "running" | "failed",
): PilotManifest {
  return {
    task_id: "t1",
    iter_id: "iter_001",
    iter_num: 1,
    run_id: "run_001",
    guideline_sha: "abc",
    started_at: "2026-05-04T00:00:00.000Z",
    started_by: "methodologist",
    state,
    ...(autoCritique ? { auto_critique_state: autoCritique } : {}),
  };
}

describe("derivePhase", () => {
  it("running + run_status running → running", () => {
    expect(derivePhase(manifest("running"), "running")).toBe("running");
  });

  it("running + run_status null (e.g. just started) → running", () => {
    expect(derivePhase(manifest("running"), null)).toBe("running");
  });

  it("running + run_status failed → failed", () => {
    expect(derivePhase(manifest("running"), "failed")).toBe("failed");
  });

  it("running + run_status complete_with_errors → failed", () => {
    // A run that completed-with-errors has had patient-level failures —
    // surface that as a failed phase so the UI flags it.
    expect(derivePhase(manifest("running"), "complete_with_errors")).toBe("failed");
  });

  it("ready_to_validate → awaiting_validation", () => {
    expect(derivePhase(manifest("ready_to_validate"), "complete")).toBe("awaiting_validation");
  });

  it("complete + auto_critique_state running → critiquing", () => {
    expect(derivePhase(manifest("complete", "running"), "complete")).toBe("critiquing");
  });

  it("complete + no auto_critique_state → complete", () => {
    expect(derivePhase(manifest("complete"), "complete")).toBe("complete");
  });

  it("complete + auto_critique_state failed → complete (critique failure is a flag, not a phase)", () => {
    // The iter is still complete from a lifecycle standpoint; a failed critique
    // is a separate quality concern, not a non-terminal state.
    expect(derivePhase(manifest("complete", "failed"), "complete")).toBe("complete");
  });

  it("abandoned → abandoned regardless of run_status", () => {
    expect(derivePhase(manifest("abandoned"), "running")).toBe("abandoned");
    expect(derivePhase(manifest("abandoned"), "complete")).toBe("abandoned");
    expect(derivePhase(manifest("abandoned"), null)).toBe("abandoned");
  });

  it("abandoned wins over auto_critique_state", () => {
    // If a methodologist abandons mid-critique, the iter is abandoned.
    expect(derivePhase(manifest("abandoned", "running"), "complete")).toBe("abandoned");
  });
});

describe("transitionPhase", () => {
  it("set_state → ready_to_validate writes the new state", () => {
    const m = fullManifest("running");
    const next = transitionPhase(m, { type: "set_state", state: "ready_to_validate" });
    expect(next.state).toBe("ready_to_validate");
    expect(next.completed_at).toBeUndefined(); // not a terminal state
  });

  it("set_state → complete stamps completed_at", () => {
    const m = fullManifest("ready_to_validate");
    const next = transitionPhase(m, { type: "set_state", state: "complete" });
    expect(next.state).toBe("complete");
    expect(next.completed_at).toBeDefined();
  });

  it("set_state → abandoned stamps completed_at", () => {
    const m = fullManifest("running");
    const next = transitionPhase(m, { type: "set_state", state: "abandoned" });
    expect(next.state).toBe("abandoned");
    expect(next.completed_at).toBeDefined();
  });

  it("set_state with notes overwrites the notes field", () => {
    const m = { ...fullManifest("running"), notes: "old" };
    const next = transitionPhase(m, {
      type: "set_state",
      state: "complete",
      notes: "looks good",
    });
    expect(next.notes).toBe("looks good");
  });

  it("set_state without notes preserves prior notes", () => {
    const m = { ...fullManifest("running"), notes: "old" };
    const next = transitionPhase(m, { type: "set_state", state: "complete" });
    expect(next.notes).toBe("old");
  });

  it("begin_auto_critique sets auto_critique_state running", () => {
    const m = fullManifest("complete");
    const next = transitionPhase(m, { type: "begin_auto_critique" });
    expect(next.auto_critique_state).toBe("running");
  });

  it("begin_auto_critique throws when iter is not yet complete", () => {
    const m = fullManifest("running");
    expect(() => transitionPhase(m, { type: "begin_auto_critique" })).toThrow(
      /cannot begin_auto_critique/,
    );
  });

  it("complete_auto_critique deletes the auto_critique_state field", () => {
    const m = fullManifest("complete", "running");
    const next = transitionPhase(m, { type: "complete_auto_critique" });
    expect(next.auto_critique_state).toBeUndefined();
    // The deletion semantics matter: derivePhase reads "complete" only when
    // the field is absent, not when it's any other value.
    expect("auto_critique_state" in next).toBe(false);
  });

  it("fail_auto_critique sets auto_critique_state failed", () => {
    const m = fullManifest("complete", "running");
    const next = transitionPhase(m, { type: "fail_auto_critique" });
    expect(next.auto_critique_state).toBe("failed");
  });

  it("transitionPhase + derivePhase compose: complete → critiquing → complete", () => {
    const m = fullManifest("complete");
    expect(derivePhase(m, "complete")).toBe("complete");

    const begun = transitionPhase(m, { type: "begin_auto_critique" });
    expect(derivePhase(begun, "complete")).toBe("critiquing");

    const done = transitionPhase(begun, { type: "complete_auto_critique" });
    expect(derivePhase(done, "complete")).toBe("complete");
  });

  it("transitionPhase + derivePhase compose: complete → critiquing → fail (still complete)", () => {
    // A failed critique is a flag on a complete iter, not a non-terminal phase.
    const m = fullManifest("complete");
    const begun = transitionPhase(m, { type: "begin_auto_critique" });
    const failed = transitionPhase(begun, { type: "fail_auto_critique" });
    expect(failed.auto_critique_state).toBe("failed");
    expect(derivePhase(failed, "complete")).toBe("complete");
  });
});
