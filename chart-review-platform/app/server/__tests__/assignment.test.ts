// app/server/__tests__/assignment.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { assignRecords, unassignRecords, getReviewerQueue } from "../assignment.js";
import { applySetAssessment } from "../domain/review/index.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "assign-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "t1";
const TASK = { task_id: TID, source_document_sha: "sha", fields: [{ id: "x" }] };

function readState(pid: string) {
  return JSON.parse(
    fs.readFileSync(path.join(TMP, pid, TID, "review_state.json"), "utf8"),
  );
}

describe("assignRecords / unassignRecords", () => {
  it("assigns reviewers to records and writes audit", async () => {
    // Seed records via applySetAssessment
    await applySetAssessment("p1", TASK as never, "agent", "agent-1", {
      field_id: "x",
      answer: "yes",
      status: "agent_proposed",
    });

    await assignRecords(
      { taskId: TID, patientIds: ["p1"], reviewerIds: ["alice", "bob"], reviewsRoot: TMP },
      "lead-reviewer",
    );
    expect(readState("p1").assigned_to.sort()).toEqual(["alice", "bob"]);
  });

  it("unassign removes a single reviewer", async () => {
    await applySetAssessment("p1", TASK as never, "agent", "agent-1", {
      field_id: "x",
      answer: "yes",
      status: "agent_proposed",
    });
    await assignRecords(
      { taskId: TID, patientIds: ["p1"], reviewerIds: ["alice", "bob"], reviewsRoot: TMP },
      "lead-reviewer",
    );
    await unassignRecords(
      { taskId: TID, patientIds: ["p1"], reviewerIds: ["bob"], reviewsRoot: TMP },
      "lead-reviewer",
    );
    expect(readState("p1").assigned_to).toEqual(["alice"]);
  });

  it("idempotent assign — adding existing reviewer is no-op", async () => {
    await applySetAssessment("p1", TASK as never, "agent", "agent-1", {
      field_id: "x",
      answer: "yes",
      status: "agent_proposed",
    });
    await assignRecords(
      { taskId: TID, patientIds: ["p1"], reviewerIds: ["alice"], reviewsRoot: TMP },
      "lead-reviewer",
    );
    await assignRecords(
      { taskId: TID, patientIds: ["p1"], reviewerIds: ["alice"], reviewsRoot: TMP },
      "lead-reviewer",
    );
    expect(readState("p1").assigned_to).toEqual(["alice"]);
  });
});

describe("getReviewerQueue", () => {
  it("returns assignments across all (task, patient)", async () => {
    await applySetAssessment("p1", TASK as never, "agent", "agent-1", {
      field_id: "x",
      answer: "yes",
      status: "agent_proposed",
    });
    await applySetAssessment("p2", TASK as never, "agent", "agent-1", {
      field_id: "x",
      answer: "no",
      status: "agent_proposed",
    });
    await assignRecords(
      { taskId: TID, patientIds: ["p1", "p2"], reviewerIds: ["alice"], reviewsRoot: TMP },
      "lead",
    );
    const queue = getReviewerQueue("alice", TMP);
    expect(queue).toHaveLength(2);
    expect(queue.map((q) => q.patient_id).sort()).toEqual(["p1", "p2"]);
  });
});

describe("write guard", () => {
  it("non-assigned reviewer rejected with ASSIGNMENT_REQUIRED", async () => {
    await applySetAssessment("p1", TASK as never, "agent", "agent-1", {
      field_id: "x",
      answer: "yes",
      status: "agent_proposed",
    });
    await assignRecords(
      { taskId: TID, patientIds: ["p1"], reviewerIds: ["alice"], reviewsRoot: TMP },
      "lead",
    );

    // Bob NOT assigned, write rejects
    expect(() =>
      applySetAssessment("p1", TASK as never, "reviewer", "bob", {
        field_id: "x",
        answer: "no",
        status: "overridden",
      }),
    ).toThrow(expect.objectContaining({ code: "ASSIGNMENT_REQUIRED" }));
  });

  it("assigned reviewer can write", async () => {
    await applySetAssessment("p1", TASK as never, "agent", "agent-1", {
      field_id: "x",
      answer: "yes",
      status: "agent_proposed",
    });
    await assignRecords(
      { taskId: TID, patientIds: ["p1"], reviewerIds: ["alice"], reviewsRoot: TMP },
      "lead",
    );

    // Alice IS assigned, write succeeds
    await applySetAssessment("p1", TASK as never, "reviewer", "alice", {
      field_id: "x",
      answer: "no",
      status: "overridden",
    });
    expect(readState("p1").field_assessments[0].status).toBe("overridden");
  });

  it("empty assigned_to → any reviewer can write (back-compat)", async () => {
    await applySetAssessment("p1", TASK as never, "agent", "agent-1", {
      field_id: "x",
      answer: "yes",
      status: "agent_proposed",
    });
    // No assignment — empty assigned_to (default)

    await applySetAssessment("p1", TASK as never, "reviewer", "anyone", {
      field_id: "x",
      answer: "no",
      status: "overridden",
    });
    expect(readState("p1").field_assessments[0].status).toBe("overridden");
  });
});
