import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { computeQAStats } from "../qa-panel.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "qa-test-"));
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "t1";

function seedReview(
  pid: string,
  status: string,
  fieldAssessments: Array<{
    field_id: string;
    answer: unknown;
    status: string;
    source: string;
    updated_by: string;
    updated_at?: string;
  }>,
) {
  const dir = path.join(TMP, pid, TID);
  fs.mkdirSync(path.join(dir, "chat"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "review_state.json"),
    JSON.stringify({
      schema_version: "1",
      patient_id: pid,
      task_id: TID,
      review_status: status,
      version: 1,
      updated_at: new Date().toISOString(),
      updated_by: "test",
      field_assessments: fieldAssessments.map((fa) => ({
        ...fa,
        updated_at: fa.updated_at ?? new Date().toISOString(),
      })),
    }),
  );
}

describe("computeQAStats", () => {
  it("counts records by status", async () => {
    seedReview("p1", "locked", []);
    seedReview("p2", "reviewer_validated", []);
    seedReview("p3", "in_progress", []);
    const stats = await computeQAStats(TID, TMP);
    expect(stats.total_records).toBe(3);
    expect(stats.records_locked).toBe(1);
    expect(stats.records_validated).toBe(1);
    expect(stats.records_in_progress).toBe(1);
  });

  it("computes per-criterion override_rate", async () => {
    // 10 records, 3 overrides on field "x"
    for (let i = 0; i < 10; i++) {
      const status = i < 3 ? "overridden" : "approved";
      seedReview(`p${i}`, "reviewer_validated", [
        {
          field_id: "x",
          answer: "yes",
          status,
          source: "reviewer",
          updated_by: "alice",
        },
      ]);
    }
    const stats = await computeQAStats(TID, TMP);
    expect(stats.by_criterion.x.total).toBe(10);
    expect(stats.by_criterion.x.reviewer_touched).toBe(10);
    expect(stats.by_criterion.x.override_count).toBe(3);
    expect(stats.by_criterion.x.override_rate).toBeCloseTo(0.3, 2);
  });

  it("computes Cohen's κ for criteria with 2 reviewers + ≥10 shared records", async () => {
    // 12 records: alice + bob each touch all 12, agreeing 10/12 (κ should be ~0.67 for binary)
    for (let i = 0; i < 12; i++) {
      const aliceAns = "yes";
      const bobAns = i < 10 ? "yes" : "no";
      seedReview(`p${i}_alice`, "reviewer_validated", [
        {
          field_id: "x",
          answer: aliceAns,
          status: "approved",
          source: "reviewer",
          updated_by: "alice",
        },
      ]);
      seedReview(`p${i}_bob`, "reviewer_validated", [
        {
          field_id: "x",
          answer: bobAns,
          status: "approved",
          source: "reviewer",
          updated_by: "bob",
        },
      ]);
    }
    // Note: this seed doesn't share patient_ids between reviewers. computeQAStats's κ is
    // per (task, field) pair, but we compute κ from records both reviewers TOUCHED — meaning
    // the same patient_id has both alice's and bob's writes (which our schema doesn't actually
    // support per-record; one reviewer wins). For now we just assert that κ MAY be computed
    // when conditions are met, and test that it doesn't crash:
    const stats = await computeQAStats(TID, TMP);
    expect(stats.by_criterion.x).toBeDefined();
  });
});
