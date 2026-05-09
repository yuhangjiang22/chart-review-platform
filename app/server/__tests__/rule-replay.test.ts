// app/server/__tests__/rule-replay.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { replayRule, type ProposedEdit } from "../domain/proposal/index.js";
import { seedSkillBundle } from "./helpers/seedSkillBundle.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rule-replay-test-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "t1";
const SHA = "deadbeef";

function seedBundle(taskId: string, fields: Array<Record<string, unknown> & { id: string }>) {
  seedSkillBundle(TMP, taskId, { fields });
  // SKILL.md is read by some downstream tooling — keep emitting it.
  fs.writeFileSync(
    path.join(TMP, "guidelines", taskId, "SKILL.md"),
    `---\nname: ${taskId}\ndescription: t.\n---\n`,
  );
}

function seedLockedRecord(pid: string, taskId: string, sha: string, answers: Record<string, unknown>) {
  const dir = path.join(TMP, "reviews", pid, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    schema_version: "1", patient_id: pid, task_id: taskId,
    review_status: "locked", lock_task_sha: sha,
    version: 1, updated_at: new Date().toISOString(), updated_by: "test",
    field_assessments: Object.entries(answers).map(([fid, val]) => ({
      field_id: fid, status: "approved", source: "reviewer",
      updated_at: new Date().toISOString(), updated_by: "alice",
      answer: val,
    })),
  }));
}

describe("replayRule — deterministic gate replay", () => {
  it("flips records where new DSL evaluates differently from old DSL", async () => {
    seedBundle(TID, [
      { id: "pathology_report_present", prompt: "P1" },
      { id: "surgical_pathology_present", prompt: "P2" },
      { id: "cytology", prompt: "Q", is_applicable_when: "pathology_report_present == 'no'" },
    ]);
    seedLockedRecord("p1", TID, SHA, {
      pathology_report_present: "no",
      surgical_pathology_present: "no",
      cytology: true,
    });
    seedLockedRecord("p2", TID, SHA, {
      pathology_report_present: "no",
      surgical_pathology_present: "yes",
      cytology: true,
    });
    seedLockedRecord("p3", TID, SHA, {
      pathology_report_present: "yes",
      cytology: false,
    });
    const edit: ProposedEdit = {
      field_id: "cytology",
      edit_type: "is_applicable_when_replace",
      payload: "pathology_report_present == 'no' AND surgical_pathology_present == 'no'",
      rationale: "...",
    };
    const result = await replayRule({
      taskId: TID, fromSha: SHA, edit, reviewsRoot: path.join(TMP, "reviews"),
    });
    expect(result.flip_count).toBeGreaterThan(0);
    const flipped = result.flips.map((f) => f.record_id).sort();
    expect(flipped).toContain("p2");
    expect(flipped).not.toContain("p3");
  });

  it("computes pattern_strength=strong for high flip ratio", async () => {
    seedBundle(TID, [{ id: "f1", prompt: "Q", is_applicable_when: "true" }]);
    for (let i = 0; i < 10; i++) {
      seedLockedRecord(`p${i}`, TID, SHA, { f1: true });
    }
    const edit: ProposedEdit = {
      field_id: "f1",
      edit_type: "is_applicable_when_replace",
      payload: "false",
      rationale: "all unapplicable",
    };
    const result = await replayRule({ taskId: TID, fromSha: SHA, edit, reviewsRoot: path.join(TMP, "reviews") });
    expect(result.flip_count).toBe(10);
    expect(result.pattern_strength).toBe("strong");
  });

  it("returns weak pattern for 1/N flips", async () => {
    seedBundle(TID, [
      { id: "f1", prompt: "P1" },
      { id: "f2", prompt: "Q", is_applicable_when: "f1 == 'yes'" },
    ]);
    for (let i = 0; i < 9; i++) {
      seedLockedRecord(`p${i}`, TID, SHA, { f1: "no" });
    }
    seedLockedRecord("p_special", TID, SHA, { f1: "yes", f2: true });
    const edit: ProposedEdit = {
      field_id: "f2",
      edit_type: "is_applicable_when_replace",
      payload: "f1 == 'no'",
      rationale: "...",
    };
    const result = await replayRule({ taskId: TID, fromSha: SHA, edit, reviewsRoot: path.join(TMP, "reviews") });
    expect(result.pattern_strength).toBe("weak");
  });
});

describe("replayRule — heuristic prose replay", () => {
  it("returns records whose answered field intersects edited field id", async () => {
    seedBundle(TID, [{ id: "f1", prompt: "Q" }]);
    seedLockedRecord("p1", TID, SHA, { f1: true });
    seedLockedRecord("p2", TID, SHA, { f1: false });
    const edit: ProposedEdit = {
      field_id: "f1",
      edit_type: "guidance_prose_append",
      payload: "...",
      rationale: "...",
    };
    const result = await replayRule({ taskId: TID, fromSha: SHA, edit, reviewsRoot: path.join(TMP, "reviews") });
    expect(result.flips.length).toBe(2);
    expect(result.flips.every((f) => f.change.includes("may be affected"))).toBe(true);
  });
});
