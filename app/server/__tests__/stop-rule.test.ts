import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { evaluateStopRule } from "../domain/iter/stop-rule.js";

let tmp: string;
const TID = "ph";

function seedSkill() {
  const skillDir = path.join(tmp, ".claude/skills", `chart-review-${TID}`);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "meta.yaml"), "task_type: phenotype_validation\n");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: chart-review-ph\ndescription: t\n---\n");
}

function seedIterManifest(iterId: string, opts: { state?: string; started_at: string; completed_at?: string }) {
  const dir = path.join(tmp, ".claude/skills", `chart-review-${TID}`, "pilots", iterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    iter_id: iterId,
    task_id: TID,
    state: opts.state ?? "complete",
    started_at: opts.started_at,
    completed_at: opts.completed_at,
  }));
}

function seedAppliedProposal(ruleId: string, applied_at: string) {
  const dir = path.join(tmp, "proposals", TID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ruleId}.yaml`),
`rule_id: ${ruleId}
task_id: ${TID}
field_id: f1
status: applied
created_at: ${applied_at}
created_by: test
nl_rule: x
applied:
  applied_at: ${applied_at}
  applied_by: test
  resulting_sha: sha:abc
`);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stop-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  seedSkill();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
});

describe("evaluateStopRule", () => {
  it("returns ready_to_lock when last 2 iters had zero applied proposals", () => {
    seedIterManifest("iter_001", { started_at: "2026-05-01T00:00:00Z", completed_at: "2026-05-02T00:00:00Z" });
    seedIterManifest("iter_002", { started_at: "2026-05-02T00:00:00Z", completed_at: "2026-05-03T00:00:00Z" });
    seedIterManifest("iter_003", { started_at: "2026-05-03T00:00:00Z", completed_at: "2026-05-04T00:00:00Z" });
    seedAppliedProposal("r1", "2026-05-01T12:00:00Z");  // applied during iter_001
    // iter_002, iter_003 — no applied proposals

    const result = evaluateStopRule({ taskId: TID });
    expect(result.ready_to_lock).toBe(true);
    expect(result.reason).toMatch(/two consecutive iters/i);
    expect(result.applied_per_iter).toEqual([
      { iter_id: "iter_002", applied_count: 0 },
      { iter_id: "iter_003", applied_count: 0 },
    ]);
  });

  it("returns not-ready when the most recent iter had >0 applied proposals", () => {
    seedIterManifest("iter_001", { started_at: "2026-05-01T00:00:00Z", completed_at: "2026-05-02T00:00:00Z" });
    seedIterManifest("iter_002", { started_at: "2026-05-02T00:00:00Z", completed_at: "2026-05-03T00:00:00Z" });
    seedAppliedProposal("r1", "2026-05-02T12:00:00Z");  // applied during iter_002
    const result = evaluateStopRule({ taskId: TID });
    expect(result.ready_to_lock).toBe(false);
  });

  it("returns not-ready with fewer than 2 complete iters", () => {
    seedIterManifest("iter_001", { started_at: "2026-05-01T00:00:00Z", completed_at: "2026-05-02T00:00:00Z" });
    const result = evaluateStopRule({ taskId: TID });
    expect(result.ready_to_lock).toBe(false);
    expect(result.reason).toMatch(/at least two complete iters/i);
  });

  it("ignores incomplete iters", () => {
    seedIterManifest("iter_001", { started_at: "2026-05-01T00:00:00Z", completed_at: "2026-05-02T00:00:00Z" });
    seedIterManifest("iter_002", { started_at: "2026-05-02T00:00:00Z", completed_at: "2026-05-03T00:00:00Z" });
    seedIterManifest("iter_003", { state: "running", started_at: "2026-05-03T00:00:00Z" });
    const result = evaluateStopRule({ taskId: TID });
    // Only iter_001 + iter_002 are complete; both had zero applied → ready
    expect(result.ready_to_lock).toBe(true);
  });
});
