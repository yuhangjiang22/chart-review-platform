import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { verifyProposalApplication } from "../domain/proposal/verify-application.js";

let tmp: string;
const TID = "ph";

function seedSkill(taskId: string) {
  const skillDir = path.join(tmp, ".claude/skills", `chart-review-${taskId}`);
  fs.mkdirSync(path.join(skillDir, "references/criteria"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "meta.yaml"), "task_type: phenotype_validation\n");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: chart-review-ph\ndescription: t\n---\n");
  fs.writeFileSync(path.join(skillDir, "references/criteria/f1.md"),
`---
field_id: f1
answer_kind: boolean
---
`);
}

function seedAppliedProposal(taskId: string, ruleId: string, patientIds: string[]) {
  const dir = path.join(tmp, "proposals", taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ruleId}.yaml`),
`rule_id: ${ruleId}
task_id: ${taskId}
field_id: f1
status: applied
created_at: 2026-05-05T00:00:00Z
created_by: test
nl_rule: dummy
trigger:
  type: override
  patient_id: ${patientIds[0]}
expected_outcome:
${patientIds.map((p) => `  - record_id: ${p}\n    expected_change: flip-to-true`).join("\n")}
applied:
  applied_at: 2026-05-05T01:00:00Z
  applied_by: test
  resulting_sha: sha256:abc
`);
}

function seedReview(taskId: string, patientId: string, fieldId: string, truth: unknown) {
  const dir = path.join(tmp, "reviews", patientId, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"),
    JSON.stringify({
      patient_id: patientId,
      task_id: taskId,
      field_assessments: [
        { field_id: fieldId, answer: truth, source: "reviewer", status: "approved" },
      ],
    }),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  process.env.CHART_REVIEW_PROPOSALS_ROOT = path.join(tmp, "proposals");
  process.env.CHART_REVIEW_REVIEWS_ROOT = path.join(tmp, "reviews");
  seedSkill(TID);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  delete process.env.CHART_REVIEW_PROPOSALS_ROOT;
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

describe("verifyProposalApplication", () => {
  it("returns per-patient before/after for the targeted criterion only", async () => {
    seedAppliedProposal(TID, "r1", ["p1", "p2"]);
    seedReview(TID, "p1", "f1", true);
    seedReview(TID, "p2", "f1", false);

    const result = await verifyProposalApplication({
      taskId: TID,
      ruleId: "r1",
      reRunCriterion: async (_taskId, _patientId, _fieldId) => true,
    });

    expect(result.field_id).toBe("f1");
    expect(result.results).toEqual([
      { patient_id: "p1", agent_answer: true,  ground_truth: true,  matches: true  },
      { patient_id: "p2", agent_answer: true,  ground_truth: false, matches: false },
    ]);
    expect(result.fixed_count).toBe(1);
    expect(result.still_failing_count).toBe(1);
  });

  it("throws if the proposal is not in 'applied' status", async () => {
    const dir = path.join(tmp, "proposals", TID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "r2.yaml"),
`rule_id: r2
task_id: ${TID}
field_id: f1
status: draft
created_at: 2026-05-05T00:00:00Z
created_by: test
nl_rule: x
`);
    await expect(verifyProposalApplication({
      taskId: TID,
      ruleId: "r2",
      reRunCriterion: async () => null,
    })).rejects.toThrow(/not in applied status/i);
  });

  it("dedupes patient ids from trigger + expected_outcome", async () => {
    seedAppliedProposal(TID, "r3", ["p1", "p1", "p2"]);  // p1 in both trigger and expected_outcome
    seedReview(TID, "p1", "f1", true);
    seedReview(TID, "p2", "f1", true);
    const result = await verifyProposalApplication({
      taskId: TID,
      ruleId: "r3",
      reRunCriterion: async () => true,
    });
    expect(result.results.map((r) => r.patient_id).sort()).toEqual(["p1", "p2"]);
  });
});
