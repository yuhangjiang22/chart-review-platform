// app/server/__tests__/skill-bundle.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { loadSkillBundle } from "../domain/rubric/index.js";
import { seedSkillBundle } from "./helpers/seedSkillBundle.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skill-bundle-test-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "t1";

function seedBundle(taskId: string, opts: {
  meta?: { task_version?: string; review_unit?: string; source_document_sha?: string };
  criteria?: Array<{ id: string; [k: string]: unknown }>;
}) {
  seedSkillBundle(TMP, taskId, {
    task_version: opts.meta?.task_version,
    review_unit: opts.meta?.review_unit,
    source_document_sha: opts.meta?.source_document_sha,
    fields: opts.criteria ?? [],
  });
}

describe("loadSkillBundle", () => {
  it("loads bundle into CompiledTask shape", () => {
    seedBundle(TID, {
      meta: { task_version: "2.1", review_unit: "encounter", source_document_sha: "abc" },
      criteria: [
        { id: "f1", prompt: "Q1", answer_schema: { enum: [true, false] } },
        { id: "f2", prompt: "Q2", is_applicable_when: "f1 == true" },
      ],
    });
    const task = loadSkillBundle(TID);
    expect(task.task_id).toBe(TID);
    expect(task.task_version).toBe("2.1");
    expect(task.review_unit).toBe("encounter");
    expect(task.source_document_sha).toBe("abc");
    expect(task.fields).toHaveLength(2);
    expect(task.fields.find((f) => f.id === "f1")?.prompt).toBe("Q1");
    expect(task.fields.find((f) => f.id === "f2")?.is_applicable_when).toBe("f1 == true");
  });

  it("returns fields sorted by criterion filename for deterministic ordering", () => {
    seedBundle(TID, {
      criteria: [
        { id: "z_last", prompt: "Z" },
        { id: "a_first", prompt: "A" },
        { id: "m_middle", prompt: "M" },
      ],
    });
    const task = loadSkillBundle(TID);
    expect(task.fields.map((f) => f.id)).toEqual(["a_first", "m_middle", "z_last"]);
  });

  it("throws if guideline directory missing", () => {
    expect(() => loadSkillBundle("nonexistent")).toThrow(/guideline not found/i);
  });

  it("silently skips a malformed criterion file rather than failing the whole load", () => {
    // loadPhenotypeCriteria treats one bad file as a localized problem, not
    // a startup-blocker. Operationally safer than letting one stray edit
    // prevent the whole guideline from loading.
    seedBundle(TID, {
      criteria: [{ id: "good", prompt: "ok", answer_schema: { type: "boolean" } }],
    });
    const skillCriteriaDir = path.join(
      TMP, ".claude", "skills", `chart-review-${TID}`, "references", "criteria",
    );
    // A markdown file without YAML frontmatter is silently skipped by the loader.
    fs.writeFileSync(path.join(skillCriteriaDir, "broken.md"), "this has no frontmatter\n");
    const bundle = loadSkillBundle(TID);
    expect(bundle.fields.map((f) => f.id)).toEqual(["good"]);
  });
});

describe("loadSkillBundle — operational layer", () => {
  /** Seed a guideline package with the full operational layer. */
  function seedGuidelineWithOperational(taskId: string) {
    seedSkillBundle(TMP, taskId, {
      fields: [
        {
          id: "f1",
          prompt: "Q1",
          uses: { keyword_sets: ["lex_a"], code_sets: ["codes_a"] },
        },
      ],
    });
    const refsDir = path.join(TMP, ".claude", "skills", `chart-review-${taskId}`, "references");

    fs.mkdirSync(path.join(refsDir, "keyword_sets"), { recursive: true });
    fs.writeFileSync(
      path.join(refsDir, "keyword_sets", "lex_a.md"),
      "---\nid: lex_a\ndescription: Test lexicon.\nterms:\n  - alpha\n  - beta\n---\n",
    );

    fs.mkdirSync(path.join(refsDir, "code_sets"), { recursive: true });
    fs.writeFileSync(
      path.join(refsDir, "code_sets", "codes_a.md"),
      "---\nid: codes_a\nsystem: ICD10\ncodes:\n  - code: X1\n    description: test\n---\n",
    );

    fs.mkdirSync(path.join(refsDir, "edge_cases"), { recursive: true });
    fs.writeFileSync(
      path.join(refsDir, "edge_cases", "trap_1.md"),
      "---\nid: trap_1\npattern: test pattern\napplies_to:\n  - f1\n---\n",
    );

    fs.mkdirSync(path.join(refsDir, "exemplars"), { recursive: true });
    fs.writeFileSync(
      path.join(refsDir, "exemplars", "ex_a.md"),
      "---\nid: ex_a\ntitle: Example\n---\n\nbody\n",
    );
  }

  it("returns operational artifacts on the bundle", () => {
    const tid = "lcp_op";
    seedGuidelineWithOperational(tid);

    const task = loadSkillBundle(tid);
    expect(task.operational).toBeDefined();
    expect(task.operational?.keyword_sets?.lex_a?.terms).toEqual(["alpha", "beta"]);
    expect(task.operational?.code_sets?.codes_a?.system).toBe("ICD10");
    expect(task.operational?.edge_cases?.[0]?.id).toBe("trap_1");
    expect(task.operational?.exemplars?.ex_a).toContain("body");
  });

  it("returns an empty operational layer when accumulated artifacts are missing", () => {
    seedBundle("plain", { criteria: [{ id: "f1", prompt: "Q" }] });
    const task = loadSkillBundle("plain");
    expect(task.operational).toBeDefined();
    expect(task.operational?.keyword_sets).toEqual({});
    expect(task.operational?.code_sets).toEqual({});
    expect(task.operational?.edge_cases).toEqual([]);
    expect(task.operational?.exemplars).toEqual({});
  });
});
