import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock the skill-dir resolver so criterion-md.ts + provenance.ts read/write
// under a tmp dir. Both modules import phenotypeSkillDir from @chart-review/rubric.
let skillDir = "";
vi.mock("@chart-review/rubric", () => ({
  phenotypeSkillDir: () => skillDir,
  // criterion-md + snapshotAfterEdit now resolve through these; the fixture is a
  // single baseline rubric at skillDir, so all three point there.
  resolveRubricRoot: () => skillDir,
  baselineRubricRoot: () => skillDir,
}));

import {
  applyRefinement,
  revertRefinement,
  readRefinementLog,
  type RefinementCardSnapshot,
} from "./provenance.js";

const FIELD = "cancer_type";

function writeCriterion(extraction_guidance: string): void {
  const dir = path.join(skillDir, "references", "criteria");
  fs.mkdirSync(dir, { recursive: true });
  const md = `---
field_id: ${FIELD}
prompt: What histology?
answer_schema:
  enum:
    - adenocarcinoma
    - other
cardinality: one
group: characterization
---

# Criterion: ${FIELD}

## Definition

The histologic type.

## Extraction guidance

${extraction_guidance}

## Examples

- "x" → adenocarcinoma
`;
  fs.writeFileSync(path.join(dir, `${FIELD}.md`), md);
}

function readGuidance(): string {
  const raw = fs.readFileSync(path.join(skillDir, "references", "criteria", `${FIELD}.md`), "utf8");
  const m = /## Extraction guidance\s*\n([\s\S]*?)(?=\n## )/m.exec(raw);
  return m ? m[1].trim() : "";
}

const card: RefinementCardSnapshot = {
  examples: [
    { patient_id: "p1", agent_answer: "other", reviewer_answer: "adenocarcinoma", classification_hint: "true_ambiguity", excerpt: "adenosquamous" },
  ],
  gap_summary: "no rule for mixed histology",
  rationale: "predominant component",
  holdout: { delta: 0.667, n_fixed: 2, n_regressed: 0 },
  refine_n: 2,
};

beforeEach(() => {
  skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "refine-prov-"));
});
afterEach(() => {
  fs.rmSync(skillDir, { recursive: true, force: true });
});

describe("applyRefinement", () => {
  it("appends the rule to existing guidance and logs the card + prior text", () => {
    writeCriterion("- existing rule one");
    const entry = applyRefinement({
      taskId: "cancer-diagnosis",
      fieldId: FIELD,
      ruleText: "map mixed histology to the predominant component",
      card,
      appliedBy: "methodologist",
      iterId: "iter_039",
      sessionId: "session_026",
      now: "2026-06-13T00:00:00.000Z",
      entryId: "e1",
    });
    // criterion got the appended bullet
    const g = readGuidance();
    expect(g).toContain("- existing rule one");
    expect(g).toContain("- map mixed histology to the predominant component");
    // log entry captured prior + new + card
    expect(entry.prior_extraction_guidance).toContain("existing rule one");
    expect(entry.prior_extraction_guidance).not.toContain("predominant component");
    expect(entry.new_extraction_guidance).toContain("predominant component");
    expect(entry.card?.gap_summary).toBe("no rule for mixed histology");
    expect(entry.applied_by).toBe("methodologist");
  });

  it("is idempotent — re-applying the same rule doesn't duplicate it or re-log", () => {
    writeCriterion("- existing");
    applyRefinement({ taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "the new rule", appliedBy: "r", sessionId: "s", now: "t1", entryId: "e1" });
    const after1 = readGuidance();
    applyRefinement({ taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "the new rule", appliedBy: "r", sessionId: "s", now: "t2", entryId: "e2" });
    const after2 = readGuidance();
    expect(after2).toBe(after1); // guidance unchanged on the second apply
    expect(after2.split("the new rule").length - 1).toBe(1); // rule appears exactly once
    expect(readRefinementLog("cancer-diagnosis", FIELD).length).toBe(1); // no duplicate log entry
  });

  it("writes '- rule' when there is no prior guidance", () => {
    writeCriterion("");
    applyRefinement({
      taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "the rule",
      appliedBy: "r", now: "t", entryId: "e1",
    });
    expect(readGuidance()).toBe("- the rule");
  });

  it("strips a trailing/leading bullet duplication (caller passes clean text)", () => {
    writeCriterion("- a");
    applyRefinement({ taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "b", appliedBy: "r", now: "t", entryId: "e1" });
    expect(readGuidance()).toBe("- a\n\n- b");
  });

  it("throws on empty rule text", () => {
    writeCriterion("- a");
    expect(() =>
      applyRefinement({ taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "   ", appliedBy: "r" }),
    ).toThrow(/empty/);
  });

  it("throws on a missing criterion", () => {
    writeCriterion("- a"); // creates cancer_type, not has_local_recurrence
    expect(() =>
      applyRefinement({ taskId: "cancer-diagnosis", fieldId: "has_local_recurrence", ruleText: "x", appliedBy: "r" }),
    ).toThrow(/not found/);
  });
});

describe("readRefinementLog", () => {
  it("returns entries newest-first and filters by field", () => {
    writeCriterion("- a");
    applyRefinement({ taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "r1", appliedBy: "r", now: "t1", entryId: "e1" });
    applyRefinement({ taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "r2", appliedBy: "r", now: "t2", entryId: "e2" });
    const log = readRefinementLog("cancer-diagnosis");
    expect(log.map((e) => e.entry_id)).toEqual(["e2", "e1"]); // newest-first
    expect(readRefinementLog("cancer-diagnosis", FIELD)).toHaveLength(2);
    expect(readRefinementLog("cancer-diagnosis", "nope")).toHaveLength(0);
  });

  it("returns [] when no log exists", () => {
    writeCriterion("- a");
    expect(readRefinementLog("cancer-diagnosis")).toEqual([]);
  });
});

describe("revertRefinement", () => {
  it("restores the pre-apply guidance and marks the entry reverted (no intervening edit)", () => {
    writeCriterion("- a");
    applyRefinement({ taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "added", appliedBy: "r", now: "t1", entryId: "e1" });
    expect(readGuidance()).toBe("- a\n\n- added");
    const res = revertRefinement({ taskId: "cancer-diagnosis", entryId: "e1", by: "r2", now: "t2" });
    expect(res.intervening_edit).toBe(false);
    expect(readGuidance()).toBe("- a"); // restored
    const log = readRefinementLog("cancer-diagnosis");
    expect(log[0].reverted).toMatchObject({ by: "r2", intervening_edit: false });
  });

  it("flags intervening_edit when the guidance changed since the apply", () => {
    writeCriterion("- a");
    applyRefinement({ taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "added", appliedBy: "r", now: "t1", entryId: "e1" });
    // a second apply changes the guidance after e1
    applyRefinement({ taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "more", appliedBy: "r", now: "t2", entryId: "e2" });
    const res = revertRefinement({ taskId: "cancer-diagnosis", entryId: "e1", by: "r2", now: "t3" });
    expect(res.intervening_edit).toBe(true);
    // restored to e1's prior snapshot (just "- a")
    expect(readGuidance()).toBe("- a");
  });

  it("throws on unknown / already-reverted entry", () => {
    writeCriterion("- a");
    applyRefinement({ taskId: "cancer-diagnosis", fieldId: FIELD, ruleText: "added", appliedBy: "r", now: "t1", entryId: "e1" });
    expect(() => revertRefinement({ taskId: "cancer-diagnosis", entryId: "nope", by: "r" })).toThrow(/not found/);
    revertRefinement({ taskId: "cancer-diagnosis", entryId: "e1", by: "r", now: "t2" });
    expect(() => revertRefinement({ taskId: "cancer-diagnosis", entryId: "e1", by: "r", now: "t3" })).toThrow(/already reverted/);
  });
});
