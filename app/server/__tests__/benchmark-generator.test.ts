import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { generateBenchmark } from "../benchmark-generator";
import type { RuleProposal } from "../domain/proposal/index.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-test-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("generateBenchmark", () => {
  it("writes a benchmark.md to tasks/<tid>/versions/<sha>/", () => {
    // After T9, guidelineDir("t1") = TMP/.claude/skills/chart-review-t1 (no env override).
    const skillVersionDir = path.join(TMP, ".claude", "skills", "chart-review-t1", "versions", "newsha");
    fs.mkdirSync(skillVersionDir, { recursive: true });
    const rule: RuleProposal = {
      rule_id: "r1",
      task_id: "t1",
      field_id: "f1",
      status: "applied",
      created_at: "2026-04-30T13:45:00Z",
      created_by: "alice",
      nl_rule: "test rule",
      proposed_edit: {
        field_id: "f1",
        edit_type: "is_applicable_when_replace",
        payload: "x == 'no'",
        rationale: "...",
      },
      replay: {
        total_locked: 10,
        flip_count: 4,
        pattern_strength: "moderate",
        flips: [
          { record_id: "p1", change: "applicable=true → applicable=false" },
          { record_id: "p3", change: "applicable=true → applicable=false" },
        ],
        computed_at: "2026-04-30T13:45:08Z",
      },
      applied: { applied_at: "2026-04-30T15:12:00Z", applied_by: "bob", resulting_sha: "newsha" },
    };
    generateBenchmark({ taskId: "t1", fromSha: "oldsha", toSha: "newsha", rule });
    const bm = fs.readFileSync(path.join(skillVersionDir, "benchmark.md"), "utf8");
    expect(bm).toContain("# Benchmark");
    expect(bm).toContain("rule-id: r1");
    expect(bm).toContain("Total locked");
    expect(bm).toContain("Records flipped");
    expect(bm).toContain("p1");
  });

  it("includes the edit diff section", () => {
    const skillVersionDir = path.join(TMP, ".claude", "skills", "chart-review-t1", "versions", "newsha");
    fs.mkdirSync(skillVersionDir, { recursive: true });
    const rule: RuleProposal = {
      rule_id: "r1",
      task_id: "t1",
      field_id: "f1",
      status: "applied",
      created_at: "x",
      created_by: "alice",
      nl_rule: "test",
      proposed_edit: { field_id: "f1", edit_type: "is_applicable_when_replace", payload: "newgate", rationale: "..." },
      replay: { total_locked: 5, flip_count: 2, pattern_strength: "moderate", flips: [], computed_at: "x" },
      applied: { applied_at: "x", applied_by: "bob", resulting_sha: "newsha" },
    };
    generateBenchmark({ taskId: "t1", fromSha: "oldsha", toSha: "newsha", rule });
    const bm = fs.readFileSync(path.join(skillVersionDir, "benchmark.md"), "utf8");
    expect(bm).toContain("Diff from previous SHA");
    expect(bm).toContain("is_applicable_when");
    expect(bm).toContain("newgate");
  });
});
