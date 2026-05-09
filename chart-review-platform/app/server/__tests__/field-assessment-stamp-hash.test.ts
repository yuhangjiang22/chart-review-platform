import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// vi.mock is hoisted to the top of the file, so the factory must not
// reference variables that are initialised after the hoist point. Use
// vi.hoisted() to create the mock function inside the hoist boundary.
const { mockHashes } = vi.hoisted(() => ({ mockHashes: vi.fn() }));

vi.mock("../domain/iter/pilots.js", () => ({
  snapshotCriterionHashesSync: mockHashes,
}));

import { applyUiAction } from "../domain/review/index.js";
import type { CompiledTask } from "../tasks.js";

const minimalTask: CompiledTask = {
  task_id: "test_task",
  review_unit: "patient",
  manual_version: "1",
  source_document_sha: "sha-test",
  fields: [{ id: "C1", prompt: "Test criterion" }],
};

let TMP: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-hash-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
  mockHashes.mockReset();
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

describe("set_field_assessment stamps captured_against_schema_hash", () => {
  it("populates captured_against_schema_hash from snapshotCriterionHashesSync(task.task_id)", () => {
    mockHashes.mockReturnValue({ C1: "deadbeef12345678" });

    const result = applyUiAction("p1", minimalTask, "reviewer", "u1", {
      type: "set_field_assessment",
      payload: {
        field_id: "C1",
        answer: "yes",
        status: "approved",
      },
    });

    const fa = result.state.field_assessments.find((f) => f.field_id === "C1");
    expect(fa).toBeDefined();
    expect(fa?.captured_against_schema_hash).toBe("deadbeef12345678");
  });

  it("leaves the field undefined when snapshot has no entry for the field_id", () => {
    mockHashes.mockReturnValue({});  // empty snapshot — represents missing skill dir

    const result = applyUiAction("p1", minimalTask, "reviewer", "u1", {
      type: "set_field_assessment",
      payload: {
        field_id: "C1",
        answer: "yes",
        status: "approved",
      },
    });

    const fa = result.state.field_assessments.find((f) => f.field_id === "C1");
    expect(fa?.captured_against_schema_hash).toBeUndefined();
  });
});
