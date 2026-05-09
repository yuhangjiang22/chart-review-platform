import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { runMigration } from "../migration";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "t1";

function seedLockedRecord(pid: string, sha: string) {
  const dir = path.join(TMP, pid, TID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    schema_version: "1", patient_id: pid, task_id: TID,
    review_status: "locked", lock_task_sha: sha,
    locked_at: "2026-04-29T10:00:00Z", locked_by: "alice",
    version: 5, updated_at: new Date().toISOString(), updated_by: "alice",
    field_assessments: [{ field_id: "x", status: "approved", source: "reviewer", updated_at: new Date().toISOString(), updated_by: "alice" }],
  }));
}

function readState(pid: string) {
  return JSON.parse(fs.readFileSync(path.join(TMP, pid, TID, "review_state.json"), "utf8"));
}

describe("runMigration", () => {
  it("archives locked record to _archive/<sha>.json + reopens it", async () => {
    seedLockedRecord("p1", "v1sha");
    const result = await runMigration({
      taskId: TID, fromSha: "v1sha", toSha: "v2sha", patientIds: ["p1"],
      reviewsRoot: TMP, triggeredBy: "alice",
    });
    expect(result.archived).toContain("p1");
    expect(result.reopened).toContain("p1");

    const archivePath = path.join(TMP, "p1", TID, "_archive", "v1sha.json");
    expect(fs.existsSync(archivePath)).toBe(true);

    const rs = readState("p1");
    expect(rs.review_status).toBe("agent_complete");
    expect(rs.lock_task_sha).toBeUndefined();
  });

  it("skips records with non-matching from_sha", async () => {
    seedLockedRecord("p1", "v0_sha");
    const result = await runMigration({
      taskId: TID, fromSha: "v1sha", toSha: "v2sha", patientIds: ["p1"],
      reviewsRoot: TMP, triggeredBy: "alice",
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].patient_id).toBe("p1");
  });

  it("idempotent — re-running on already-archived record is a no-op", async () => {
    seedLockedRecord("p1", "v1sha");
    await runMigration({
      taskId: TID, fromSha: "v1sha", toSha: "v2sha", patientIds: ["p1"],
      reviewsRoot: TMP, triggeredBy: "alice",
    });
    const result = await runMigration({
      taskId: TID, fromSha: "v1sha", toSha: "v2sha", patientIds: ["p1"],
      reviewsRoot: TMP, triggeredBy: "alice",
    });
    expect(result.archived.length).toBe(0);
    expect(result.errors.length).toBe(1);
  });
});
