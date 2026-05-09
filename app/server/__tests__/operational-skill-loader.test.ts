import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadKeywordSets, loadCodeSets, loadEdgeCases, loadExemplars } from "../domain/rubric/phenotype-skill.js";

// Derive platform root from test file location: __dirname -> ../../..
const PLATFORM_ROOT = path.resolve(import.meta.dirname, "../../..");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-op-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
});

describe("loadKeywordSets", () => {
  it("parses YAML frontmatter from skill keyword_sets/*.md", () => {
    const dir = path.join(tmp, ".claude/skills/chart-review-foo/references/keyword_sets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "imaging.md"),
`---
id: imaging
description: Imaging terms
terms:
  - mass
  - nodule
synonyms:
  GGO: [ground-glass opacity]
---

# Keyword set: imaging

Free-form prose body the agent reads.
`);
    const result = loadKeywordSets("foo");
    expect(result).toEqual({
      imaging: {
        id: "imaging",
        description: "Imaging terms",
        terms: ["mass", "nodule"],
        synonyms: { GGO: ["ground-glass opacity"] },
      },
    });
  });

  it("returns empty object when keyword_sets/ does not exist", () => {
    expect(loadKeywordSets("nonexistent")).toEqual({});
  });

  it("skips files with malformed frontmatter without throwing", () => {
    const dir = path.join(tmp, ".claude/skills/chart-review-foo/references/keyword_sets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.md"), "no frontmatter here");
    expect(loadKeywordSets("foo")).toEqual({});
  });

  it("skips files whose frontmatter has no id field", () => {
    const dir = path.join(tmp, ".claude/skills/chart-review-foo/references/keyword_sets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "no-id.md"),
`---
description: missing the id field
terms: [foo]
---
`);
    expect(loadKeywordSets("foo")).toEqual({});
  });
});

describe("loadCodeSets", () => {
  it("parses YAML frontmatter from skill code_sets/*.md", () => {
    const dir = path.join(tmp, ".claude/skills/chart-review-foo/references/code_sets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "lung_cancer_icd10.md"),
`---
id: lung_cancer_icd10
description: Active lung cancer ICD-10
system: ICD10
includes_pattern: [C34.*]
codes:
  - { code: C34.00, description: Main bronchus }
excludes:
  - { code: Z85.118, reason: history only }
---
`);
    const result = loadCodeSets("foo");
    expect(result.lung_cancer_icd10.codes).toEqual([{ code: "C34.00", description: "Main bronchus" }]);
    expect(result.lung_cancer_icd10.excludes).toEqual([{ code: "Z85.118", reason: "history only" }]);
  });

  it("returns empty when missing", () => {
    expect(loadCodeSets("nope")).toEqual({});
  });
});

describe("loadEdgeCases", () => {
  it("returns one EdgeCase per skill edge_cases/*.md", () => {
    const dir = path.join(tmp, ".claude/skills/chart-review-foo/references/edge_cases");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "z85.md"),
`---
id: z85_history_only
pattern: |
  Z85.118 with no active C34
applies_to: [icd_lung_cancer_present]
failure_mode: counting history as active
correct_answer_hint: false
---
`);
    fs.writeFileSync(path.join(dir, "carcinoid.md"),
`---
id: carcinoid_other
pattern: typical carcinoid
applies_to: [pathology_lung_primary]
failure_mode: defaulting to nsclc
correct_answer_hint: other_lung
---
`);
    const result = loadEdgeCases("foo");
    expect(result.map((e) => e.id).sort()).toEqual(["carcinoid_other", "z85_history_only"]);
  });

  it("returns [] when missing", () => {
    expect(loadEdgeCases("nope")).toEqual([]);
  });
});

describe("loadExemplars", () => {
  it("returns id→full markdown for skill exemplars/*.md", () => {
    const dir = path.join(tmp, ".claude/skills/chart-review-foo/references/exemplars");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pt_017.md"), "# Patient 017\n\nNarrative goes here.");
    const result = loadExemplars("foo");
    expect(result).toEqual({ pt_017: "# Patient 017\n\nNarrative goes here." });
  });

  it("returns {} when missing", () => {
    expect(loadExemplars("nope")).toEqual({});
  });
});

describe("loadKeywordSets — real lung phenotype", () => {
  it("loads hand-authored keyword sets including imaging_findings", () => {
    process.env.CHART_REVIEW_PLATFORM_ROOT = PLATFORM_ROOT;
    const result = loadKeywordSets("lung-cancer-phenotype");
    // Hand-authored sets must be present. Codify-derived sets (kw_*) may
    // also exist after a codify run; don't forbid them.
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(["imaging_findings", "lung_anatomy", "pathology_terms"]),
    );
    expect(result.imaging_findings.terms).toContain("nodule");
  });
});

describe("loadCodeSets — real lung phenotype", () => {
  it("loads lung_cancer_icd10 with codes array populated", () => {
    process.env.CHART_REVIEW_PLATFORM_ROOT = PLATFORM_ROOT;
    const result = loadCodeSets("lung-cancer-phenotype");
    expect(result.lung_cancer_icd10).toBeDefined();
    expect(result.lung_cancer_icd10.codes!.length).toBeGreaterThan(5);
  });
});

describe("loadEdgeCases — real lung phenotype", () => {
  it("returns at least 3 edges", () => {
    process.env.CHART_REVIEW_PLATFORM_ROOT = PLATFORM_ROOT;
    const result = loadEdgeCases("lung-cancer-phenotype");
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.find((e) => e.id === "z85_118_personal_history_excluded")).toBeDefined();
  });
});
