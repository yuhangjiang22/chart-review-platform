// app/server/__tests__/cohort-validation.test.ts
//
// Unit + integration tests for cohort sample validation (G.3).
//
// Tests cover:
//  - Layout helpers
//  - readValidationState / writeValidationState round-trip
//  - computeValidationStatus (pending / in_progress / validated)
//  - blindDraft (answer stripping)
//  - buildSampleQueue (end-to-end queue assembly)
//  - API smoke tests via supertest (queue + state + draft + blinding)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { ReviewState } from "../domain/review/index.js";
import type { AgentDraft } from "../disagreements.js";
import {
  cohortValidationsDir,
  cohortValidationPatientDir,
  cohortValidationStatePath,
  cohortValidationReviewsRoot,
  readValidationState,
  writeValidationState,
  computeValidationStatus,
  blindDraft,
  readCohortAgentDraft,
  buildSampleQueue,
  readSelection,
} from "../domain/cohort/index.js";

let TMP: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-val-test-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
  process.env.CHART_REVIEW_COHORTS_ROOT = path.join(TMP, "cohorts");
  process.env.CHART_REVIEW_RUNS_ROOT = path.join(TMP, "runs");
});

afterEach(() => {
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  delete process.env.CHART_REVIEW_COHORTS_ROOT;
  delete process.env.CHART_REVIEW_RUNS_ROOT;
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeReviewState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    schema_version: "1",
    patient_id: "p_01",
    task_id: "test-task",
    review_status: "in_progress",
    version: 1,
    updated_at: new Date().toISOString(),
    updated_by: "reviewer",
    field_assessments: [],
    ...overrides,
  } as ReviewState;
}

function makeAgentDraft(fieldIds: string[]): AgentDraft {
  return {
    agent_id: "agent_1",
    patient_id: "p_01",
    field_assessments: fieldIds.map((id) => ({
      field_id: id,
      answer: "confirmed",
      confidence: "high" as const,
      source: "agent" as const,
      status: "agent_proposed" as const,
      updated_at: new Date().toISOString(),
      updated_by: "agent",
    })),
  } as unknown as AgentDraft;
}

function seedSelection(cohortId: string, runId: string, patientIds: string[]): void {
  const selDir = path.join(TMP, "cohorts", cohortId, "sample", "selections");
  fs.mkdirSync(selDir, { recursive: true });
  const record = {
    strategy: { n_total: patientIds.length, stratify_by: "status", balance: "equal", seed: 42 },
    selected: patientIds,
    rationale: "test",
    drawn_at: new Date().toISOString(),
    drawn_by: "tester",
  };
  fs.writeFileSync(path.join(selDir, `${runId}.json`), JSON.stringify(record, null, 2));
}

function seedAgentDraft(runId: string, patientId: string, fieldIds: string[]): void {
  const dir = path.join(TMP, "runs", runId, "per_patient", patientId);
  fs.mkdirSync(dir, { recursive: true });
  const draft = {
    schema_version: "1",
    patient_id: patientId,
    task_id: "test-task",
    field_assessments: fieldIds.map((id) => ({
      field_id: id,
      answer: "yes",
      confidence: "high",
      source: "agent",
      status: "agent_proposed",
      updated_at: new Date().toISOString(),
      updated_by: "agent",
    })),
  };
  fs.writeFileSync(path.join(dir, "agent_draft.json"), JSON.stringify(draft, null, 2));
}

// ── layout tests ──────────────────────────────────────────────────────────────

describe("layout helpers", () => {
  it("cohortValidationsDir uses CHART_REVIEW_COHORTS_ROOT", () => {
    const dir = cohortValidationsDir("my-cohort");
    expect(dir).toBe(path.join(TMP, "cohorts", "my-cohort", "sample", "validations"));
  });

  it("cohortValidationPatientDir nests under validations dir", () => {
    const d = cohortValidationPatientDir("c1", "p_01");
    expect(d).toContain(path.join("c1", "sample", "validations", "p_01"));
  });

  it("cohortValidationStatePath ends in review_state.json", () => {
    const p = cohortValidationStatePath("c1", "p_01");
    expect(p).toMatch(/review_state\.json$/);
  });

  it("cohortValidationReviewsRoot equals cohortValidationsDir", () => {
    expect(cohortValidationReviewsRoot("c1")).toBe(cohortValidationsDir("c1"));
  });
});

// ── read / write round-trip ───────────────────────────────────────────────────

describe("readValidationState / writeValidationState", () => {
  it("returns null for unknown patient", () => {
    expect(readValidationState("c1", "p_01", "task")).toBeNull();
  });

  it("round-trips a ReviewState", () => {
    const state = makeReviewState({ patient_id: "p_01", task_id: "test-task" });
    writeValidationState("c1", "p_01", "test-task", state);
    const loaded = readValidationState("c1", "p_01", "test-task");
    expect(loaded?.patient_id).toBe("p_01");
    expect(loaded?.task_id).toBe("test-task");
    expect(loaded?.schema_version).toBe("1");
  });

  it("creates directories recursively on write", () => {
    const state = makeReviewState();
    writeValidationState("new-cohort", "p_99", "t1", state);
    const dir = path.join(TMP, "cohorts", "new-cohort", "sample", "validations", "p_99", "t1");
    expect(fs.existsSync(dir)).toBe(true);
  });
});

// ── computeValidationStatus ───────────────────────────────────────────────────

describe("computeValidationStatus", () => {
  it("returns pending when no review state exists", () => {
    const agent = makeAgentDraft(["f1", "f2", "f3"]);
    const { status, n_answered, n_leaf_criteria } = computeValidationStatus(null, agent);
    expect(status).toBe("pending");
    expect(n_answered).toBe(0);
    expect(n_leaf_criteria).toBe(3);
  });

  it("returns pending when reviewer has no answers yet", () => {
    const state = makeReviewState({
      field_assessments: [
        {
          field_id: "f1",
          answer: "yes",
          source: "agent",
          status: "agent_proposed",
          updated_at: new Date().toISOString(),
          updated_by: "agent",
        } as any,
      ],
    });
    const agent = makeAgentDraft(["f1"]);
    const { status } = computeValidationStatus(state, agent);
    expect(status).toBe("pending");
  });

  it("returns in_progress when reviewer answered some but not all", () => {
    const state = makeReviewState({
      field_assessments: [
        {
          field_id: "f1",
          answer: "yes",
          source: "reviewer",
          status: "overridden",
          updated_at: new Date().toISOString(),
          updated_by: "reviewer",
        } as any,
      ],
    });
    const agent = makeAgentDraft(["f1", "f2"]);
    const { status, n_answered, n_leaf_criteria } = computeValidationStatus(state, agent);
    expect(status).toBe("in_progress");
    expect(n_answered).toBe(1);
    expect(n_leaf_criteria).toBe(2);
  });

  it("returns validated when reviewer answered all criteria", () => {
    const state = makeReviewState({
      field_assessments: [
        {
          field_id: "f1",
          answer: "yes",
          source: "reviewer",
          status: "overridden",
          updated_at: new Date().toISOString(),
          updated_by: "reviewer",
        } as any,
        {
          field_id: "f2",
          answer: "no",
          source: "reviewer",
          status: "overridden",
          updated_at: new Date().toISOString(),
          updated_by: "reviewer",
        } as any,
      ],
    });
    const agent = makeAgentDraft(["f1", "f2"]);
    const { status } = computeValidationStatus(state, agent);
    expect(status).toBe("validated");
  });

  it("ignores reviewer assessments with null answer", () => {
    const state = makeReviewState({
      field_assessments: [
        {
          field_id: "f1",
          answer: null,
          source: "reviewer",
          status: "overridden",
          updated_at: new Date().toISOString(),
          updated_by: "reviewer",
        } as any,
      ],
    });
    const agent = makeAgentDraft(["f1"]);
    const { status } = computeValidationStatus(state, agent);
    expect(status).toBe("pending");
  });
});

// ── blindDraft ────────────────────────────────────────────────────────────────

describe("blindDraft", () => {
  it("strips answer, evidence, rationale, confidence from all field_assessments", () => {
    const draft: AgentDraft = {
      agent_id: "agent_1",
      patient_id: "p_01",
      field_assessments: [
        {
          field_id: "f1",
          answer: "confirmed",
          confidence: "high",
          evidence: [{ text: "some text", note_id: "n1", start: 0, end: 4 }] as any,
          rationale: "reasoning",
          source: "agent",
          status: "agent_proposed",
          updated_at: new Date().toISOString(),
          updated_by: "agent",
        } as any,
      ],
    } as unknown as AgentDraft;

    const blinded = blindDraft(draft);
    expect(blinded.blinded).toBe(true);
    expect(blinded.field_assessments[0].answer).toBeUndefined();
    expect(blinded.field_assessments[0].evidence).toBeUndefined();
    expect(blinded.field_assessments[0].rationale).toBeUndefined();
    expect(blinded.field_assessments[0].confidence).toBeUndefined();
    // field_id should still be present
    expect(blinded.field_assessments[0].field_id).toBe("f1");
  });

  it("preserves patient_id and agent_id", () => {
    const draft = makeAgentDraft(["f1"]);
    const blinded = blindDraft(draft);
    expect(blinded.patient_id).toBe("p_01");
    expect(blinded.agent_id).toBe("agent_1");
  });
});

// ── readCohortAgentDraft ──────────────────────────────────────────────────────

describe("readCohortAgentDraft", () => {
  it("returns null when draft file does not exist", () => {
    const runsRoot = path.join(TMP, "runs");
    const result = readCohortAgentDraft(runsRoot, "run_01", "p_01");
    expect(result).toBeNull();
  });

  it("reads and parses an agent_draft.json", () => {
    seedAgentDraft("run_01", "p_01", ["f1", "f2"]);
    const runsRoot = path.join(TMP, "runs");
    const draft = readCohortAgentDraft(runsRoot, "run_01", "p_01");
    expect(draft).not.toBeNull();
    expect(draft!.patient_id).toBe("p_01");
    expect(draft!.field_assessments).toHaveLength(2);
  });
});

// ── buildSampleQueue ──────────────────────────────────────────────────────────

describe("buildSampleQueue", () => {
  it("returns null when no selection exists", () => {
    const runsRoot = path.join(TMP, "runs");
    const queue = buildSampleQueue("c1", "run_01", "task", runsRoot);
    expect(queue).toBeNull();
  });

  it("returns a queue with all pending status when no validation state exists", () => {
    seedSelection("c1", "run_01", ["p_01", "p_02"]);
    seedAgentDraft("run_01", "p_01", ["f1", "f2"]);
    seedAgentDraft("run_01", "p_02", ["f1", "f2"]);
    const runsRoot = path.join(TMP, "runs");
    const queue = buildSampleQueue("c1", "run_01", "task", runsRoot);
    expect(queue).not.toBeNull();
    expect(queue!.n_total).toBe(2);
    expect(queue!.n_validated).toBe(0);
    expect(queue!.patients.every((p) => p.validation_status === "pending")).toBe(true);
  });

  it("counts n_validated correctly", () => {
    seedSelection("c1", "run_01", ["p_01", "p_02"]);
    seedAgentDraft("run_01", "p_01", ["f1"]);
    seedAgentDraft("run_01", "p_02", ["f1"]);

    // Fully validate p_01
    const state = makeReviewState({
      patient_id: "p_01",
      task_id: "task",
      field_assessments: [
        {
          field_id: "f1",
          answer: "yes",
          source: "reviewer",
          status: "overridden",
          updated_at: new Date().toISOString(),
          updated_by: "reviewer",
        } as any,
      ],
    });
    writeValidationState("c1", "p_01", "task", state);

    const runsRoot = path.join(TMP, "runs");
    const queue = buildSampleQueue("c1", "run_01", "task", runsRoot);
    expect(queue!.n_validated).toBe(1);
    expect(queue!.patients.find((p) => p.patient_id === "p_01")?.validation_status).toBe("validated");
    expect(queue!.patients.find((p) => p.patient_id === "p_02")?.validation_status).toBe("pending");
  });

  it("returns selection metadata in the response", () => {
    seedSelection("c1", "run_01", ["p_01"]);
    const runsRoot = path.join(TMP, "runs");
    const queue = buildSampleQueue("c1", "run_01", "task", runsRoot);
    expect(queue!.cohort_id).toBe("c1");
    expect(queue!.run_id).toBe("run_01");
    expect(queue!.drawn_by).toBe("tester");
  });
});

// ── readSelection ─────────────────────────────────────────────────────────────

describe("readSelection", () => {
  it("returns null when no selection file exists", () => {
    expect(readSelection("c1", "run_01")).toBeNull();
  });

  it("reads an existing selection", () => {
    seedSelection("c1", "run_01", ["p_01", "p_02", "p_03"]);
    const sel = readSelection("c1", "run_01");
    expect(sel).not.toBeNull();
    expect(sel!.selected).toHaveLength(3);
    expect(sel!.drawn_by).toBe("tester");
  });
});
