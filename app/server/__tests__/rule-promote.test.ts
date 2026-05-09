// app/server/__tests__/rule-promote.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { promoteRule, writeProposal, readProposal, RuleProposal } from "../domain/proposal/index.js";
import { seedSkillBundle } from "./helpers/seedSkillBundle.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rule-promote-test-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
  process.env.CHART_REVIEW_REVIEWS_ROOT = path.join(TMP, "reviews");
  process.env.CHART_REVIEW_PROPOSALS_ROOT = path.join(TMP, "proposals");
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "t1";

function seedBundle(taskId: string, fields: Array<Record<string, unknown> & { id: string }>) {
  // seedSkillBundle now writes meta.yaml + SKILL.md to .claude/skills/chart-review-<taskId>/
  // (the T9 canonical guideline dir). No need to write SKILL.md separately.
  seedSkillBundle(TMP, taskId, { fields });
}

function seedLockedRecord(pid: string, taskId: string, sha: string) {
  const dir = path.join(TMP, "reviews", pid, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    schema_version: "1", patient_id: pid, task_id: taskId,
    review_status: "locked", lock_task_sha: sha, locked_at: "x", locked_by: "alice",
    version: 5, updated_at: new Date().toISOString(), updated_by: "alice",
    field_assessments: [{ field_id: "f1", status: "approved", source: "reviewer",
      updated_at: new Date().toISOString(), updated_by: "alice" }],
  }));
}

function makeApprovedProposal(): RuleProposal {
  return {
    rule_id: "r1",
    task_id: TID,
    field_id: "f1",
    status: "pending_methodologist_review",
    created_at: "2026-04-30T13:45:00Z",
    created_by: "alice",
    nl_rule: "test rule",
    proposed_edit: {
      field_id: "f1",
      edit_type: "is_applicable_when_replace",
      payload: "x == 'no'",
      rationale: "...",
    },
    replay: { total_locked: 1, flip_count: 1, pattern_strength: "strong",
              flips: [{ record_id: "p1", change: "applicable=true → false" }],
              computed_at: "2026-04-30T13:45:08Z" },
  };
}

describe("promoteRule — happy path", () => {
  it("applies the edit, bumps SHA, runs migration, generates benchmark, transitions to applied", async () => {
    seedBundle(TID, [
      { id: "f1", prompt: "Q", is_applicable_when: "x == 'yes'" },
    ]);
    const { computeTaskSha } = await import("../lock");
    // After T9, guidelineDir(TID) = TMP/.claude/skills/chart-review-t1/ — compute
    // fromSha from the canonical skill dir so it matches what promoteRule uses.
    const fromSha = computeTaskSha(path.join(TMP, ".claude", "skills", `chart-review-${TID}`));
    seedLockedRecord("p1", TID, fromSha);

    const proposal = makeApprovedProposal();
    writeProposal(proposal);

    await promoteRule({ taskId: TID, ruleId: "r1", methodologistId: "bob" });

    const after = readProposal(TID, "r1");
    expect(after?.status).toBe("applied");
    expect(after?.applied?.applied_by).toBe("bob");
    expect(after?.applied?.resulting_sha).toMatch(/^[a-f0-9]{16}$/);

    const newField = parseSkillCriterion(TMP, TID, "f1");
    expect(newField.is_applicable_when).toBe("x == 'no'");

    const newSha = after!.applied!.resulting_sha;
    // After T9, versions live under guidelineDir(TID) = TMP/.claude/skills/chart-review-t1/
    expect(fs.existsSync(path.join(TMP, ".claude", "skills", `chart-review-${TID}`, "versions", newSha, "benchmark.md"))).toBe(true);

    expect(fs.existsSync(path.join(TMP, "reviews", "p1", TID, "_archive", `${fromSha}.json`))).toBe(true);
  });

  it("stales sibling pending proposals on the same field", async () => {
    seedBundle(TID, [{ id: "f1", prompt: "Q" }]);
    const sibling: RuleProposal = {
      rule_id: "sibling-rule",
      task_id: TID,
      field_id: "f1",
      status: "pending_methodologist_review",
      created_at: "2026-04-30T14:00:00Z",
      created_by: "carol",
      nl_rule: "another rule on f1",
    };
    writeProposal(sibling);
    writeProposal(makeApprovedProposal());

    await promoteRule({ taskId: TID, ruleId: "r1", methodologistId: "bob" });

    const sib = readProposal(TID, "sibling-rule");
    expect(sib?.status).toBe("stale_after_v_next");
  });

  it("supports methodologist_edit override", async () => {
    seedBundle(TID, [{ id: "f1", prompt: "Q", is_applicable_when: "x == 'yes'" }]);
    writeProposal(makeApprovedProposal());

    await promoteRule({
      taskId: TID, ruleId: "r1", methodologistId: "bob",
      methodologistEdit: {
        field_id: "f1", edit_type: "is_applicable_when_replace",
        payload: "x == 'maybe'", rationale: "methodologist refined",
      },
    });

    const newField = parseSkillCriterion(TMP, TID, "f1");
    expect(newField.is_applicable_when).toBe("x == 'maybe'");
  });
});

/** Read a skill-format markdown criterion's frontmatter for assertion. */
function parseSkillCriterion(root: string, taskId: string, fieldId: string): Record<string, unknown> {
  const p = path.join(
    root, ".claude", "skills", `chart-review-${taskId}`, "references", "criteria", `${fieldId}.md`,
  );
  const txt = fs.readFileSync(p, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/s.exec(txt);
  if (!m) throw new Error(`no frontmatter in ${p}`);
  return require("yaml").parse(m[1]) as Record<string, unknown>;
}
