import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { simulateImpact } from "../impact-simulator";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "impact-test-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "t1";

function seedVersion(taskId: string, sha: string, fields: Array<Record<string, unknown> & { id: string }>) {
  // After T9, guidelineDir(taskId) = TMP/.claude/skills/chart-review-<taskId>.
  // versionsDir is guidelineDir(taskId)/versions.
  const dir = path.join(TMP, ".claude", "skills", `chart-review-${taskId}`, "versions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sha}.json`), JSON.stringify({ task_id: taskId, fields }));
}

function seedRecord(pid: string, taskId: string, sha: string, fieldIds: string[]) {
  const dir = path.join(TMP, "reviews", pid, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    schema_version: "1", patient_id: pid, task_id: taskId,
    review_status: "locked", lock_task_sha: sha,
    version: 1, updated_at: new Date().toISOString(), updated_by: "test",
    field_assessments: fieldIds.map((id) => ({
      field_id: id, status: "approved", source: "reviewer", updated_at: new Date().toISOString(), updated_by: "alice",
    })),
  }));
}

describe("simulateImpact", () => {
  it("flags records that touched changed fields", () => {
    seedVersion(TID, "from", [{ id: "x", is_applicable_when: "a == 'yes'" }]);
    seedVersion(TID, "to", [{ id: "x", is_applicable_when: "a == 'no'" }]);
    seedRecord("p1", TID, "from", ["x"]);
    seedRecord("p2", TID, "from", ["x"]);

    const result = simulateImpact({ taskId: TID, fromSha: "from", toSha: "to", reviewsRoot: path.join(TMP, "reviews") });
    expect(result.affected.length).toBe(2);
    expect(result.changed_field_ids).toContain("x");
  });

  it("excludes records whose answers don't intersect changed fields", () => {
    seedVersion(TID, "from", [{ id: "x", is_applicable_when: "a == 'yes'" }, { id: "y", prompt: "stable" }]);
    seedVersion(TID, "to", [{ id: "x", is_applicable_when: "a == 'no'" }, { id: "y", prompt: "stable" }]);
    seedRecord("p1", TID, "from", ["x"]);
    seedRecord("p2", TID, "from", ["y"]);

    const result = simulateImpact({ taskId: TID, fromSha: "from", toSha: "to", reviewsRoot: path.join(TMP, "reviews") });
    expect(result.affected.map((a) => a.patient_id)).toContain("p1");
    expect(result.unaffected).toContain("p2");
  });

  it("includes added fields in changed set (no records affected if no record has the new field)", () => {
    seedVersion(TID, "from", [{ id: "x" }]);
    seedVersion(TID, "to", [{ id: "x" }, { id: "z" }]);
    seedRecord("p1", TID, "from", ["x"]);

    const result = simulateImpact({ taskId: TID, fromSha: "from", toSha: "to", reviewsRoot: path.join(TMP, "reviews") });
    expect(result.changed_field_ids).toContain("z");
    expect(result.affected.length).toBe(0);
    expect(result.unaffected).toContain("p1");
  });
});
