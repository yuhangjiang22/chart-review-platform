/**
 * Tests for computeRevisitsForIter helper (derived-adjudications/revisits.ts).
 *
 * Testing style: vi.mock for loadCompiledTask, snapshotCriterionHashesSync, and
 * getPilotManifest (to avoid requiring a full skill directory on disk), plus
 * real tmp-dir filesystem fixtures for review_state.json and agent draft files.
 *
 * Four behaviors covered:
 *   1. Records whose captured_against_schema_hash equals the current hash → NOT in results.
 *   2. Records whose hash differs + agent draft exists → appear with prior_answer and
 *      agent_rerun_answer populated.
 *   3. Records whose hash differs but no agent draft exists → appear with agent_rerun_answer=null.
 *   4. Patients with no field_assessment for a changed criterion → no row emitted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// ─── Hoisted mock handles ──────────────────────────────────────────────────────
// vi.mock factories are hoisted before imports; use vi.hoisted to create
// the mock functions so they're available inside the factory closures.

const { mockLoadCompiledTask, mockSnapshotHashes, mockGetPilotManifest } = vi.hoisted(() => ({
  mockLoadCompiledTask: vi.fn(),
  mockSnapshotHashes: vi.fn(),
  mockGetPilotManifest: vi.fn(),
}));

vi.mock("../tasks.js", () => ({
  loadCompiledTask: mockLoadCompiledTask,
}));

vi.mock("../domain/iter/pilots.js", () => ({
  snapshotCriterionHashesSync: mockSnapshotHashes,
  getPilotManifest: mockGetPilotManifest,
}));

// ─── Subject under test ───────────────────────────────────────────────────────
import { computeRevisitsForIter } from "../derived-adjudications/revisits.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TASK_ID = "test-task";
const ITER_ID = "iter_001";
const RUN_ID = "run_abc123";

/** Hash that is "current" — what the criterion is hashed to NOW. */
const CURRENT_HASH = "newHash0000000001";
/** Hash stamped on an old record — differs from CURRENT_HASH → stale. */
const STALE_HASH = "oldHash0000000001";

// ─── Shared state ─────────────────────────────────────────────────────────────

let TMP: string;
let reviewsRoot: string;
let runsRoot: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "revisits-test-"));
  reviewsRoot = path.join(TMP, "reviews");
  runsRoot = path.join(TMP, "runs");
  fs.mkdirSync(reviewsRoot, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });

  // Override env vars so the helper reads from our tmp tree.
  process.env.CHART_REVIEW_REVIEWS_ROOT = reviewsRoot;
  process.env.CHART_REVIEW_RUNS_ROOT = runsRoot;

  // Default mock values — individual tests can override.
  mockLoadCompiledTask.mockReset();
  mockSnapshotHashes.mockReset();
  mockGetPilotManifest.mockReset();

  // Sensible defaults.
  mockLoadCompiledTask.mockReturnValue({
    task_id: TASK_ID,
    source_document_sha: "sha",
    fields: [
      { id: "C1", prompt: "Is C1 present?" },
      { id: "C2", prompt: "Is C2 present?" },
    ],
  });
  mockSnapshotHashes.mockReturnValue({ C1: CURRENT_HASH, C2: CURRENT_HASH });
  mockGetPilotManifest.mockReturnValue({
    task_id: TASK_ID,
    iter_id: ITER_ID,
    iter_num: 1,
    run_id: RUN_ID,
    guideline_sha: "sha",
    started_at: new Date().toISOString(),
    started_by: "tester",
    state: "running",
  });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
  delete process.env.CHART_REVIEW_RUNS_ROOT;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeReviewState(patientId: string, fieldAssessments: unknown[]): void {
  const dir = path.join(reviewsRoot, patientId, TASK_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "review_state.json"),
    JSON.stringify({ field_assessments: fieldAssessments }),
  );
}

function writeAgentDraft(patientId: string, fieldAssessments: unknown[]): void {
  const dir = path.join(runsRoot, RUN_ID, "per_patient", patientId, "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agent_1.json"),
    JSON.stringify({ field_assessments: fieldAssessments }),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeRevisitsForIter", () => {
  it("(1) records whose captured_against_schema_hash equals the current hash do NOT appear", () => {
    // Patient p1 has a field_assessment for C1 that is FRESH (hash matches).
    writeReviewState("p1", [
      {
        field_id: "C1",
        source: "reviewer",
        answer: "yes",
        captured_against_schema_hash: CURRENT_HASH,
      },
    ]);

    const result = computeRevisitsForIter({ taskId: TASK_ID, iterId: ITER_ID });

    expect(result.rows).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.criteria_changed).toBe(0);
  });

  it("(2) records whose hash differs appear with prior_answer and agent_rerun_answer when a draft exists", () => {
    // Patient p2 has a stale C1 assessment; agent draft has a new answer.
    writeReviewState("p2", [
      {
        field_id: "C1",
        source: "reviewer",
        answer: "no",
        rationale: "looked stale",
        captured_against_schema_hash: STALE_HASH,
      },
    ]);
    writeAgentDraft("p2", [
      {
        field_id: "C1",
        answer: "yes",
        rationale: "agent says yes",
      },
    ]);

    const result = computeRevisitsForIter({ taskId: TASK_ID, iterId: ITER_ID });

    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.criteria_changed).toBe(1);

    const row = result.rows[0];
    expect(row.field_id).toBe("C1");
    expect(row.patient_id).toBe("p2");
    expect(row.prior_answer).toBe("no");
    expect(row.prior_rationale).toBe("looked stale");
    expect(row.agent_rerun_answer).toBe("yes");
    expect(row.agent_rerun_rationale).toBe("agent says yes");
    expect(row.prior_captured_hash).toBe(STALE_HASH);
    expect(row.current_hash).toBe(CURRENT_HASH);
    expect(row.field_prompt_current).toBe("Is C1 present?");
  });

  it("(3) records whose hash differs but no agent draft exists appear with agent_rerun_answer=null", () => {
    // Patient p3 has a stale C1 assessment but there is no agent draft file.
    writeReviewState("p3", [
      {
        field_id: "C1",
        source: "reviewer",
        answer: "yes",
        captured_against_schema_hash: STALE_HASH,
      },
    ]);
    // No agent draft written for p3.

    const result = computeRevisitsForIter({ taskId: TASK_ID, iterId: ITER_ID });

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.patient_id).toBe("p3");
    expect(row.field_id).toBe("C1");
    expect(row.prior_answer).toBe("yes");
    expect(row.agent_rerun_answer).toBeNull();
    expect(row.agent_rerun_rationale).toBeNull();
  });

  it("(4) patients with no field_assessment for a changed criterion produce no row", () => {
    // The current hashes have C1 and C2, but the review state only records C2
    // (which happens to be fresh). C1 has no assessment at all — no row.
    // And C2's assessment is fresh — also no row. Result: zero rows.
    writeReviewState("p4", [
      {
        field_id: "C2",
        source: "reviewer",
        answer: "no",
        captured_against_schema_hash: CURRENT_HASH, // fresh → skip
      },
      // No C1 entry at all.
    ]);

    const result = computeRevisitsForIter({ taskId: TASK_ID, iterId: ITER_ID });

    expect(result.rows).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.criteria_changed).toBe(0);
  });
});
