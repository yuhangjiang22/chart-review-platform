import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  computeIterAccuracy,
  persistIterAccuracy,
  writeIterReport,
  readPrimaryCriterionIds,
} from "../domain/iter/index.js";

function writeReview(root: string, pid: string, taskId: string, assessments: any[]) {
  const dir = path.join(root, "reviews", pid, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    schema_version: "1",
    patient_id: pid,
    task_id: taskId,
    review_status: "in_progress",
    version: 1,
    field_assessments: assessments,
  }));
}

describe("iter-accuracy", () => {
  let tmp: string;
  let prevPlatformRoot: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iter-"));
    prevPlatformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
    process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevPlatformRoot === undefined) {
      delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    } else {
      process.env.CHART_REVIEW_PLATFORM_ROOT = prevPlatformRoot;
    }
  });

  it("counts agent_proposed (no override) as correct", () => {
    writeReview(tmp, "p1", "t1", [
      { field_id: "f1", answer: true, source: "agent", status: "agent_proposed" },
    ]);
    const acc = computeIterAccuracy({
      rootDir: tmp,
      taskId: "t1",
      iterId: "iter_001",
      cohortKind: "dev",
      patientIds: ["p1"],
      primaryCriterionIds: ["f1"],
    });
    expect(acc.per_criterion[0]).toMatchObject({ field_id: "f1", n_evaluable: 1, n_correct: 1, accuracy: 1 });
    expect(acc.override_count).toBe(0);
  });

  it("counts overridden (different answer) as incorrect", () => {
    writeReview(tmp, "p1", "t1", [
      {
        field_id: "f1", answer: false, source: "reviewer", status: "overridden",
        original_agent_snapshot: { answer: true },
      },
    ]);
    const acc = computeIterAccuracy({
      rootDir: tmp, taskId: "t1", iterId: "iter_001", cohortKind: "dev",
      patientIds: ["p1"], primaryCriterionIds: ["f1"],
    });
    expect(acc.per_criterion[0]).toMatchObject({ field_id: "f1", n_evaluable: 1, n_correct: 0, accuracy: 0 });
    expect(acc.override_count).toBe(1);
  });

  it("counts overridden-to-same-answer as correct (rare but possible)", () => {
    writeReview(tmp, "p1", "t1", [
      {
        field_id: "f1", answer: true, source: "reviewer", status: "overridden",
        original_agent_snapshot: { answer: true },
      },
    ]);
    const acc = computeIterAccuracy({
      rootDir: tmp, taskId: "t1", iterId: "iter_001", cohortKind: "dev",
      patientIds: ["p1"], primaryCriterionIds: ["f1"],
    });
    expect(acc.per_criterion[0].accuracy).toBe(1);
  });

  it("ignores non-primary criteria", () => {
    writeReview(tmp, "p1", "t1", [
      { field_id: "derived_x", answer: 42, source: "agent", status: "agent_proposed" },
      { field_id: "f1", answer: true, source: "agent", status: "agent_proposed" },
    ]);
    const acc = computeIterAccuracy({
      rootDir: tmp, taskId: "t1", iterId: "iter_001", cohortKind: "dev",
      patientIds: ["p1"], primaryCriterionIds: ["f1"],
    });
    expect(acc.per_criterion).toHaveLength(1);
    expect(acc.per_criterion[0].field_id).toBe("f1");
  });

  it("aggregates worst and avg across criteria", () => {
    writeReview(tmp, "p1", "t1", [
      { field_id: "f1", answer: true,  source: "agent", status: "agent_proposed" },
      { field_id: "f2", answer: false, source: "reviewer", status: "overridden",
        original_agent_snapshot: { answer: true } },
    ]);
    writeReview(tmp, "p2", "t1", [
      { field_id: "f1", answer: true, source: "agent", status: "agent_proposed" },
      { field_id: "f2", answer: true, source: "agent", status: "agent_proposed" },
    ]);
    const acc = computeIterAccuracy({
      rootDir: tmp, taskId: "t1", iterId: "iter_001", cohortKind: "dev",
      patientIds: ["p1", "p2"], primaryCriterionIds: ["f1", "f2"],
    });
    expect(acc.per_criterion.find(c => c.field_id === "f1")!.accuracy).toBe(1);
    expect(acc.per_criterion.find(c => c.field_id === "f2")!.accuracy).toBe(0.5);
    expect(acc.worst_accuracy).toEqual({ field_id: "f2", accuracy: 0.5 });
    expect(acc.avg_accuracy).toBe(0.75);
  });

  it("persistIterAccuracy merges into existing critique.json without dropping fields", () => {
    // Skill layout: .claude/skills/chart-review-t1/pilots/iter_001/
    const iterDir = path.join(tmp, ".claude", "skills", "chart-review-t1", "pilots", "iter_001");
    fs.mkdirSync(iterDir, { recursive: true });
    fs.writeFileSync(path.join(iterDir, "critique.json"), JSON.stringify({
      proposal_count: 3, cost_usd: 0.12, ran_at: "2026-05-01T00:00:00.000Z",
    }));

    const acc: any = {
      task_id: "t1", iter_id: "iter_001", cohort_kind: "dev",
      patient_ids: ["p1"], per_criterion: [], worst_accuracy: null,
      avg_accuracy: null, override_count: 0, computed_at: "2026-05-02T00:00:00.000Z",
    };
    persistIterAccuracy("t1", "iter_001", acc);

    const merged = JSON.parse(fs.readFileSync(path.join(iterDir, "critique.json"), "utf8"));
    expect(merged.proposal_count).toBe(3);
    expect(merged.cost_usd).toBe(0.12);
    expect(merged.accuracy).toEqual(acc);
  });

  it("writeIterReport writes a markdown report at the iter dir", () => {
    // Skill layout: .claude/skills/chart-review-t1/pilots/iter_001/
    const iterDir = path.join(tmp, ".claude", "skills", "chart-review-t1", "pilots", "iter_001");
    fs.mkdirSync(iterDir, { recursive: true });
    const acc: any = {
      task_id: "t1", iter_id: "iter_001", cohort_kind: "dev",
      patient_ids: ["p1", "p2"],
      per_criterion: [
        { field_id: "f1", n_evaluable: 2, n_correct: 2, accuracy: 1.0 },
        { field_id: "f2", n_evaluable: 2, n_correct: 1, accuracy: 0.5 },
      ],
      worst_accuracy: { field_id: "f2", accuracy: 0.5 },
      avg_accuracy: 0.75,
      override_count: 1,
      computed_at: "2026-05-02T00:00:00.000Z",
    };
    writeIterReport("t1", "iter_001", acc);
    const md = fs.readFileSync(path.join(iterDir, "report.md"), "utf8");
    expect(md).toContain("iter_001");
    expect(md).toContain("f1");
    expect(md).toContain("f2");
    expect(md).toContain("0.50");
  });

  it("readPrimaryCriterionIds reads criteria from skill-format markdown", () => {
    // Skill layout: .claude/skills/chart-review-t1/references/criteria/
    const criteriaDir = path.join(tmp, ".claude", "skills", "chart-review-t1", "references", "criteria");
    fs.mkdirSync(criteriaDir, { recursive: true });
    // f1: primary criterion (no derivation)
    fs.writeFileSync(path.join(criteriaDir, "f1.md"), [
      "---",
      "field_id: f1",
      "prompt: foo",
      "---",
      "Definition of f1.",
    ].join("\n"));
    // f2: derived criterion
    fs.writeFileSync(path.join(criteriaDir, "f2.md"), [
      "---",
      "field_id: f2",
      "prompt: bar",
      "derivation: f1",
      "---",
      "Definition of f2.",
    ].join("\n"));
    // f3: primary criterion (no derivation)
    fs.writeFileSync(path.join(criteriaDir, "f3.md"), [
      "---",
      "field_id: f3",
      "prompt: baz",
      "---",
      "Definition of f3.",
    ].join("\n"));
    expect(readPrimaryCriterionIds("t1")).toEqual(["f1", "f3"]);
  });
});
