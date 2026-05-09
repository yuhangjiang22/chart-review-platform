# Skill as Single Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.claude/skills/chart-review-<phenotype>/` the single canonical source for everything related to a phenotype task — content (criteria, keyword_sets, code_sets, edge_cases, exemplars, meta), state (versions, maturity, pilots, sampling), and drafts. Delete the parallel `guidelines/` directory.

**Architecture:** Today, `loadSkillBundle()` reads criteria from the skill but operational data (keyword_sets, code_sets, edge_cases, exemplars) and metadata (meta.yaml) from `guidelines/<id>/`. Versioning artifacts (`versions/`, `maturity.json`, `pilots/`, `sampling.json`) and drafts also live under `guidelines/`. We collapse all of these into the skill directory and update one function (`guidelineDir`) to resolve to the skill path. Most callers pick up the change transparently via that function.

**Tech Stack:** TypeScript (Node ESM), Vitest, YAML frontmatter parsing (existing pattern from `phenotype-skill.ts`).

---

## File Structure

**New canonical layout** (per phenotype `<id>`):

```
.claude/skills/chart-review-<id>/
├── SKILL.md                    (already exists — agent activation)
├── meta.yaml                   (NEW location — moved from guidelines/<id>/meta.yaml)
├── maturity.json               (NEW location — moved from guidelines/<id>/maturity.json)
├── sampling.json               (NEW location — moved from guidelines/<id>/sampling.json)
├── pilots/                     (NEW location)
├── versions/<sha>/             (NEW location — version archive)
└── references/
    ├── case-definition.md      (already exists)
    ├── criteria/<field>.md     (already canonical)
    ├── keyword_sets/<id>.md    (data merged into frontmatter)
    ├── code_sets/<id>.md       (data merged into frontmatter)
    ├── edge_cases/<id>.md      (one file per edge case; frontmatter holds data)
    └── exemplars/<id>.md       (already canonical)

.claude/skills/drafts/chart-review-<id>/   (NEW — replaces guidelines/drafts/<id>/)
```

**Files modified:**
- `app/server/domain/rubric/skill-bundle.ts` — `guidelineDir()` resolves to skill path; `loadOperationalLayer()` reads from skill dir; remove `meta.yaml` lookup at old path
- `app/server/domain/rubric/phenotype-skill.ts` — add operational loaders that parse frontmatter
- `app/server/authoring.ts` — drafts root points to `.claude/skills/drafts/`
- `app/server/builder-session.ts` — drafts root points to `.claude/skills/drafts/`
- `app/server/__tests__/helpers/seedSkillBundle.ts` — seeds skill layout, not guideline layout
- Test fixtures referencing `guidelines/<id>/` paths

**Files deleted:**
- `chart-review-platform/guidelines/` (entire tree, after migration)

---

## Task 1: Frontmatter loader for keyword_sets

**Files:**
- Modify: `app/server/domain/rubric/phenotype-skill.ts` (add `loadKeywordSets` near line 162)
- Test: `app/server/__tests__/operational-skill-loader.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `app/server/__tests__/operational-skill-loader.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadKeywordSets } from "../domain/rubric/phenotype-skill.js";

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform && pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: FAIL — `loadKeywordSets is not exported`.

- [ ] **Step 3: Implement `loadKeywordSets`**

Add to `app/server/domain/rubric/phenotype-skill.ts` after the existing `loadCriteria` export:

```typescript
import type { KeywordSet, CodeSet, EdgeCase } from "./skill-bundle.js";

function readFrontmatter<T>(filepath: string): T | null {
  let txt: string;
  try { txt = fs.readFileSync(filepath, "utf8"); } catch { return null; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/s.exec(txt);
  if (!m) return null;
  try { return parseYaml(m[1]) as T; } catch { return null; }
}

export function loadKeywordSets(taskId: string): Record<string, KeywordSet> {
  const dir = path.join(phenotypeSkillDir(taskId), "references", "keyword_sets");
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, KeywordSet> = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const ks = readFrontmatter<KeywordSet>(path.join(dir, f));
    if (ks?.id) out[ks.id] = ks;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform && pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/domain/rubric/phenotype-skill.ts app/server/__tests__/operational-skill-loader.test.ts
git commit -m "feat(rubric): add keyword_sets loader that reads skill markdown frontmatter"
```

---

## Task 2: Frontmatter loader for code_sets

**Files:**
- Modify: `app/server/domain/rubric/phenotype-skill.ts`
- Test: `app/server/__tests__/operational-skill-loader.test.ts`

- [ ] **Step 1: Add failing test**

Append to the existing test file:

```typescript
import { loadCodeSets } from "../domain/rubric/phenotype-skill.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: FAIL — `loadCodeSets is not exported`.

- [ ] **Step 3: Implement `loadCodeSets`**

Add to `phenotype-skill.ts`:

```typescript
export function loadCodeSets(taskId: string): Record<string, CodeSet> {
  const dir = path.join(phenotypeSkillDir(taskId), "references", "code_sets");
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, CodeSet> = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const cs = readFrontmatter<CodeSet>(path.join(dir, f));
    if (cs?.id) out[cs.id] = cs;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/server/domain/rubric/phenotype-skill.ts app/server/__tests__/operational-skill-loader.test.ts
git commit -m "feat(rubric): add code_sets loader that reads skill markdown frontmatter"
```

---

## Task 3: Frontmatter loader for edge_cases (one file per case)

**Files:**
- Modify: `app/server/domain/rubric/phenotype-skill.ts`
- Test: `app/server/__tests__/operational-skill-loader.test.ts`

Note: legacy stored all edge cases in a single `edge_cases.yaml`. Skill layout uses one `.md` per case under `references/edge_cases/`. The skill already has 3 such files in this shape; we formalize the loader.

- [ ] **Step 1: Add failing test**

```typescript
import { loadEdgeCases } from "../domain/rubric/phenotype-skill.js";

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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: FAIL — `loadEdgeCases is not exported`.

- [ ] **Step 3: Implement**

```typescript
export function loadEdgeCases(taskId: string): EdgeCase[] {
  const dir = path.join(phenotypeSkillDir(taskId), "references", "edge_cases");
  if (!fs.existsSync(dir)) return [];
  const out: EdgeCase[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const ec = readFrontmatter<EdgeCase>(path.join(dir, f));
    if (ec?.id) out.push(ec);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/server/domain/rubric/phenotype-skill.ts app/server/__tests__/operational-skill-loader.test.ts
git commit -m "feat(rubric): add edge_cases loader (one .md per case in skill)"
```

---

## Task 4: Frontmatter loader for exemplars

**Files:**
- Modify: `app/server/domain/rubric/phenotype-skill.ts`
- Test: `app/server/__tests__/operational-skill-loader.test.ts`

- [ ] **Step 1: Add failing test**

```typescript
import { loadExemplars } from "../domain/rubric/phenotype-skill.js";

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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
export function loadExemplars(taskId: string): Record<string, string> {
  const dir = path.join(phenotypeSkillDir(taskId), "references", "exemplars");
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const id = f.replace(/\.md$/, "");
    try { out[id] = fs.readFileSync(path.join(dir, f), "utf8"); } catch { /* skip */ }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/server/domain/rubric/phenotype-skill.ts app/server/__tests__/operational-skill-loader.test.ts
git commit -m "feat(rubric): add exemplars loader reading from skill"
```

---

## Task 5: Migrate lung-cancer-phenotype keyword_sets data into skill frontmatter

**Files:**
- Modify (3 files): `.claude/skills/chart-review-lung-cancer-phenotype/references/keyword_sets/{imaging_findings,lung_anatomy,pathology_terms}.md`
- Source of truth: `guidelines/lung-cancer-phenotype/keyword_sets/{imaging_findings,lung_anatomy,pathology_terms}.yaml`

For each `.md` file, merge the YAML data into the existing frontmatter. The body prose stays.

- [ ] **Step 1: Read the YAML source for `imaging_findings`**

```bash
cat guidelines/lung-cancer-phenotype/keyword_sets/imaging_findings.yaml
```

- [ ] **Step 2: Update `.claude/skills/chart-review-lung-cancer-phenotype/references/keyword_sets/imaging_findings.md`**

Replace existing frontmatter with full data (keep body):

```markdown
---
id: imaging_findings
description: Radiologic descriptors that may indicate a lung lesion.
version: "2026-04-30"
terms:
  - mass
  - nodule
  - lesion
  - opacity
  - spiculated
  - consolidation
  - ground-glass
  - GGO
  - cavitary
  - hilar
  - mediastinal
  - lymphadenopathy
  - effusion
synonyms:
  GGO: [ground-glass opacity, ground glass opacity]
  spiculated: [spiculation]
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: "2026-04-30"
  status: approved
---

(existing body kept verbatim)
```

- [ ] **Step 3: Repeat for `lung_anatomy.md`**

Read `guidelines/lung-cancer-phenotype/keyword_sets/lung_anatomy.yaml`, copy data fields (`terms`, `synonyms`, etc.) into the existing skill `.md` file's frontmatter.

- [ ] **Step 4: Repeat for `pathology_terms.md`**

Same procedure.

- [ ] **Step 5: Verify the loader sees them**

Add a smoke test in `app/server/__tests__/operational-skill-loader.test.ts`:

```typescript
describe("loadKeywordSets — real lung phenotype", () => {
  it("loads all 3 keyword sets with terms populated", () => {
    delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    const result = loadKeywordSets("lung-cancer-phenotype");
    expect(Object.keys(result).sort()).toEqual(["imaging_findings", "lung_anatomy", "pathology_terms"]);
    expect(result.imaging_findings.terms).toContain("nodule");
  });
});
```

Run: `pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/chart-review-lung-cancer-phenotype/references/keyword_sets/ app/server/__tests__/operational-skill-loader.test.ts
git commit -m "data(lung-cancer): merge keyword_sets data into skill markdown frontmatter"
```

---

## Task 6: Migrate code_sets data into skill frontmatter

**Files:**
- Modify (N files): every `.md` under `.claude/skills/chart-review-lung-cancer-phenotype/references/code_sets/`
- Source: `guidelines/lung-cancer-phenotype/code_sets/*.yaml`

- [ ] **Step 1: Inventory both directories**

```bash
ls .claude/skills/chart-review-lung-cancer-phenotype/references/code_sets/
ls guidelines/lung-cancer-phenotype/code_sets/
```

- [ ] **Step 2: For each YAML, merge into matching `.md` frontmatter**

For `lung_cancer_icd10.yaml` (other code_sets follow the same pattern):

Update `.claude/skills/chart-review-lung-cancer-phenotype/references/code_sets/lung_cancer_icd10.md` frontmatter to include all YAML fields (`includes_pattern`, `codes` array, `excludes` array, `provenance`). Keep body unchanged.

- [ ] **Step 3: Smoke test against real skill**

Append to `operational-skill-loader.test.ts`:

```typescript
describe("loadCodeSets — real lung phenotype", () => {
  it("loads lung_cancer_icd10 with codes array populated", () => {
    delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    const result = loadCodeSets("lung-cancer-phenotype");
    expect(result.lung_cancer_icd10).toBeDefined();
    expect(result.lung_cancer_icd10.codes!.length).toBeGreaterThan(5);
  });
});
```

Run: `pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/chart-review-lung-cancer-phenotype/references/code_sets/ app/server/__tests__/operational-skill-loader.test.ts
git commit -m "data(lung-cancer): merge code_sets data into skill markdown frontmatter"
```

---

## Task 7: Migrate edge_cases YAML → individual skill .md files

**Files:**
- Source: `guidelines/lung-cancer-phenotype/edge_cases.yaml` (contains `edges: [...]`)
- Target: `.claude/skills/chart-review-lung-cancer-phenotype/references/edge_cases/*.md`

The skill already has 3 `.md` files; verify each YAML edge entry has a corresponding `.md` with the data in frontmatter. Add any missing.

- [ ] **Step 1: List source edges**

```bash
grep "^  - id:" guidelines/lung-cancer-phenotype/edge_cases.yaml
```

- [ ] **Step 2: List existing skill edge files**

```bash
ls .claude/skills/chart-review-lung-cancer-phenotype/references/edge_cases/
```

- [ ] **Step 3: For each YAML edge, ensure a matching `.md` exists with full data**

Format:

```markdown
---
id: <edge_id>
pattern: |
  <pattern text>
applies_to: [<criterion1>, <criterion2>]
failure_mode: <text>
correct_answer_hint: <text>
example_ref: <optional>
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: "2026-04-30"
  status: approved
---

(optional prose body)
```

- [ ] **Step 4: Smoke test**

Append:

```typescript
describe("loadEdgeCases — real lung phenotype", () => {
  it("returns at least 3 edges", () => {
    delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    const result = loadEdgeCases("lung-cancer-phenotype");
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.find((e) => e.id === "z85_118_personal_history_excluded")).toBeDefined();
  });
});
```

Run: `pnpm vitest run app/server/__tests__/operational-skill-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/chart-review-lung-cancer-phenotype/references/edge_cases/ app/server/__tests__/operational-skill-loader.test.ts
git commit -m "data(lung-cancer): split edge_cases.yaml into per-edge skill markdown files"
```

---

## Task 8: Switch `loadOperationalLayer` to read from skill dir

**Files:**
- Modify: `app/server/domain/rubric/skill-bundle.ts:110-168` (function `loadOperationalLayer`)
- Test: `app/server/__tests__/skill-bundle.test.ts`

- [ ] **Step 1: Update `skill-bundle.test.ts` to seed skill layout instead of guideline layout**

Open `app/server/__tests__/skill-bundle.test.ts` and update the seed helper to write to `.claude/skills/chart-review-<id>/references/{keyword_sets,code_sets,edge_cases}/` with frontmatter format. Keep existing test cases.

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm vitest run app/server/__tests__/skill-bundle.test.ts`
Expected: FAIL — `loadOperationalLayer` still reads from guidelines/ path.

- [ ] **Step 3: Replace `loadOperationalLayer` body**

Replace `app/server/domain/rubric/skill-bundle.ts:110-168` with:

```typescript
import { loadKeywordSets, loadCodeSets, loadEdgeCases, loadExemplars } from "./phenotype-skill.js";

function loadOperationalLayer(taskId: string): OperationalLayer {
  return {
    keyword_sets: loadKeywordSets(taskId),
    code_sets: loadCodeSets(taskId),
    edge_cases: loadEdgeCases(taskId),
    exemplars: loadExemplars(taskId),
  };
}
```

Update the call site at `loadSkillBundle()` (currently `loadOperationalLayer(dir)`) to `loadOperationalLayer(taskId)`.

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm vitest run app/server/__tests__/skill-bundle.test.ts app/server/__tests__/operational-skill-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full server suite**

Run: `pnpm vitest run app/server/__tests__/`
Expected: PASS (or surfaces tests that hardcode `guidelines/<id>/` operational paths — fix those by updating their seeds to write to the skill dir).

- [ ] **Step 6: Commit**

```bash
git add app/server/domain/rubric/skill-bundle.ts app/server/__tests__/
git commit -m "refactor(rubric): loadOperationalLayer reads from skill dir"
```

---

## Task 9: Move `meta.yaml` into the skill and switch `guidelineDir` to skill path

**Files:**
- Move: `guidelines/lung-cancer-phenotype/meta.yaml` → `.claude/skills/chart-review-lung-cancer-phenotype/meta.yaml`
- Modify: `app/server/domain/rubric/skill-bundle.ts` (`guidelineDir`, `guidelinesRoot`, `loadSkillBundle`)
- Modify: `app/server/__tests__/helpers/seedSkillBundle.ts`

- [ ] **Step 1: Move the file**

```bash
mv guidelines/lung-cancer-phenotype/meta.yaml \
   .claude/skills/chart-review-lung-cancer-phenotype/meta.yaml
```

- [ ] **Step 2: Update `guidelineDir` and `guidelinesRoot` in `skill-bundle.ts`**

Replace lines 32-36 and 100-103:

```typescript
import { phenotypeSkillDir } from "./phenotype-skill.js";

/** Root that holds every phenotype skill directory.
 *  In the new layout, every phenotype lives at <PLATFORM_ROOT>/.claude/skills/chart-review-<id>/. */
export function phenotypesRoot(): string {
  const root = process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT;
  return path.join(root, ".claude", "skills");
}

/** Resolve a taskId to its on-disk skill directory. */
export function guidelineDir(taskId: string): string {
  return phenotypeSkillDir(taskId);
}

/** Back-compat alias — to be removed once all callers migrate. */
export const guidelinesRoot = phenotypesRoot;
```

- [ ] **Step 3: Update `isGuideline` to check skill marker**

Replace `isGuideline` (line 96-98) with:

```typescript
function isGuideline(dir: string): boolean {
  // A phenotype skill has both meta.yaml (data) and SKILL.md (agent activation).
  return fs.existsSync(path.join(dir, "meta.yaml")) && fs.existsSync(path.join(dir, "SKILL.md"));
}
```

- [ ] **Step 4: Update `listCompiledTasks` (in tasks.ts) — directories iterated must be `chart-review-*`**

Open `app/server/tasks.ts:49`. Update to filter directory entries by `chart-review-` prefix and strip the prefix when computing taskId.

```typescript
const root = phenotypesRoot();
const out: CompiledTask[] = [];
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (!entry.name.startsWith("chart-review-")) continue;
  const taskId = entry.name.replace(/^chart-review-/, "");
  if (taskId === "author" || taskId === "build" || taskId === "calibrate" ||
      taskId === "cohort" || taskId === "copilot" || taskId === "improve" ||
      taskId === "methods") continue; // verb-skills, not phenotype-skills
  if (!isSkillBundleAt(path.join(root, entry.name))) continue;
  out.push(loadSkillBundle(taskId));
}
return out;
```

- [ ] **Step 5: Update test seed helper `seedSkillBundle.ts`**

Open `app/server/__tests__/helpers/seedSkillBundle.ts`. Replace the path it writes to from `<root>/guidelines/<taskId>/` to `<root>/.claude/skills/chart-review-<taskId>/`. Ensure it writes both `meta.yaml` and an empty `SKILL.md` so `isGuideline` returns true.

- [ ] **Step 6: Run all server tests**

Run: `cd chart-review-platform && pnpm vitest run app/server/__tests__/`
Expected: surfaces test files that hardcode `guidelines/<id>/` paths in fixtures — fix each by updating the path. Likely candidates: `lock-workflow.test.ts:13,40`, `compose-agent.test.ts:64,68`, `review-copilot-blind-mode.test.ts:30`, `cohorts.test.ts`.

- [ ] **Step 7: Run UI smoke**

```bash
cd chart-review-platform
pnpm dev &  # in background
# manually open the app, open a lung-cancer review, verify criteria + tooltips render
```

- [ ] **Step 8: Commit**

```bash
git add app/server/ guidelines/lung-cancer-phenotype/meta.yaml .claude/skills/chart-review-lung-cancer-phenotype/meta.yaml
git commit -m "refactor(rubric): guidelineDir resolves to .claude/skills/chart-review-<id>"
```

---

## Task 10: Relocate operational state (versions/, maturity.json, pilots/, sampling.json)

**Files:**
- Move (filesystem): `guidelines/lung-cancer-phenotype/{versions,pilots,maturity.json,sampling.json}` → `.claude/skills/chart-review-lung-cancer-phenotype/`

Because Task 9 changed `guidelineDir()` to point at the skill dir, callers that compute paths like `path.join(guidelineDir(taskId), "versions", ...)` (in `version-archive.ts`, `maturity.ts`, `benchmark-generator.ts`, `server.ts:548,681`) now resolve to the skill dir automatically. We only need to physically move the existing files to match.

- [ ] **Step 1: Move the directories**

```bash
cd chart-review-platform
mv guidelines/lung-cancer-phenotype/versions     .claude/skills/chart-review-lung-cancer-phenotype/versions
mv guidelines/lung-cancer-phenotype/pilots       .claude/skills/chart-review-lung-cancer-phenotype/pilots
mv guidelines/lung-cancer-phenotype/maturity.json .claude/skills/chart-review-lung-cancer-phenotype/maturity.json
mv guidelines/lung-cancer-phenotype/sampling.json .claude/skills/chart-review-lung-cancer-phenotype/sampling.json
```

- [ ] **Step 2: Verify nothing else expects the old path**

```bash
grep -rn "guidelines/lung-cancer-phenotype" app lib tools 2>/dev/null
grep -rn "guidelines/.*/versions\|guidelines/.*/maturity" app 2>/dev/null
```

Expected: no remaining references in production code (test fixtures handled in Task 9).

- [ ] **Step 3: Run server tests + smoke**

```bash
pnpm vitest run app/server/__tests__/
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/chart-review-lung-cancer-phenotype/ guidelines/
git commit -m "chore(lung-cancer): relocate versions/maturity/pilots/sampling into skill dir"
```

---

## Task 11: Migrate drafts to skill location

**Files:**
- Modify: `app/server/authoring.ts:33,304-315,322`
- Modify: `app/server/builder-session.ts:25-26,47`
- Move (filesystem): `guidelines/drafts/<id>/` → `.claude/skills/drafts/chart-review-<id>/`

- [ ] **Step 1: Update `authoring.ts:33` `DRAFTS_ROOT` constant**

Open `app/server/authoring.ts`. Replace:

```typescript
const DRAFTS_ROOT = path.join(
  process.env.CHART_REVIEW_GUIDELINES_ROOT ?? path.join(PLATFORM_ROOT, "guidelines"),
  "drafts",
);
```

with:

```typescript
const DRAFTS_ROOT = path.join(
  process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT,
  ".claude", "skills", "drafts",
);

function draftSkillDir(taskId: string): string {
  return path.join(DRAFTS_ROOT, `chart-review-${taskId}`);
}
```

- [ ] **Step 2: Replace the env-var hack at lines 304-315**

The current hack temporarily reassigns `CHART_REVIEW_GUIDELINES_ROOT` so `loadSkillBundle` resolves a draft. Replace with a direct call that points the skill loader at the draft location:

```typescript
function loadDraftBundle(taskId: string): CompiledTask | null {
  const dir = draftSkillDir(taskId);
  if (!fs.existsSync(path.join(dir, "meta.yaml"))) return null;
  const prev = process.env.CHART_REVIEW_PLATFORM_ROOT;
  process.env.CHART_REVIEW_PLATFORM_ROOT = path.join(DRAFTS_ROOT, "..", "..", ".."); // points at platform root such that ".claude/skills/drafts/chart-review-<id>" resolves
  // Simpler: do the env redirect by overriding to a synthetic root where drafts live as skills.
  // Cleanest is to extend phenotypeSkillDir to accept a `root` override; do that instead:
  try {
    return loadSkillBundleFromDir(taskId, dir);
  } finally {
    if (prev === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    else process.env.CHART_REVIEW_PLATFORM_ROOT = prev;
  }
}
```

The cleanest implementation: add a new `loadSkillBundleFromDir(taskId, dir)` helper to `skill-bundle.ts` that takes the skill dir directly. Modify `phenotype-skill.ts` so each loader (`loadKeywordSets`, etc.) accepts an optional `dirOverride` argument, and `loadSkillBundleFromDir` threads that override through. Remove env-var thrashing entirely.

Pseudocode for `skill-bundle.ts`:

```typescript
export function loadSkillBundleFromDir(taskId: string, dir: string): CompiledTask {
  if (!fs.existsSync(path.join(dir, "meta.yaml"))) throw new Error(`guideline not found: ${dir}`);
  const meta = parseYaml(fs.readFileSync(path.join(dir, "meta.yaml"), "utf8")) as Record<string, unknown>;
  const fields = loadCriteria(taskId, dir) as unknown as CompiledTaskField[];
  return {
    task_id: taskId,
    ...meta,
    fields,
    operational: {
      keyword_sets: loadKeywordSets(taskId, dir),
      code_sets: loadCodeSets(taskId, dir),
      edge_cases: loadEdgeCases(taskId, dir),
      exemplars: loadExemplars(taskId, dir),
    },
  } as CompiledTask;
}
```

Each loader in `phenotype-skill.ts` becomes:

```typescript
export function loadKeywordSets(taskId: string, dirOverride?: string): Record<string, KeywordSet> {
  const skillDir = dirOverride ?? phenotypeSkillDir(taskId);
  const dir = path.join(skillDir, "references", "keyword_sets");
  ...
}
```

- [ ] **Step 3: Update `builder-session.ts` DRAFTS_ROOT (lines 25-26, 47)**

Match the new path:

```typescript
const DRAFTS_ROOT = path.join(
  process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT,
  ".claude", "skills", "drafts",
);
```

Update line 47's similar fallback the same way.

- [ ] **Step 4: Move existing drafts on disk**

```bash
mkdir -p .claude/skills/drafts
[ -d guidelines/drafts/lung-cancer-phenotype ] && \
  mv guidelines/drafts/lung-cancer-phenotype \
     .claude/skills/drafts/chart-review-lung-cancer-phenotype
[ -d guidelines/drafts/test ] && \
  mv guidelines/drafts/test .claude/skills/drafts/chart-review-test
```

- [ ] **Step 5: Run authoring + builder tests**

```bash
pnpm vitest run app/server/__tests__/ -t "authoring\|builder"
```

Expected: PASS.

- [ ] **Step 6: Smoke-test the authoring UI**

Open the app, start a guideline draft, save it, reload, verify the draft shows up. Confirm draft files appear at `.claude/skills/drafts/chart-review-<id>/`.

- [ ] **Step 7: Commit**

```bash
git add app/server/authoring.ts app/server/builder-session.ts app/server/domain/rubric/ .claude/skills/drafts/ guidelines/
git commit -m "refactor(authoring): drafts live at .claude/skills/drafts/chart-review-<id>"
```

---

## Task 12: Drop residual `guidelines/<id>/` reads and delete the legacy tree

**Files:**
- Modify: `app/server/ai-client.ts:13-14`, `methods-drafter.ts:25-26,123`, `prelock-summarizer.ts:18-19`, `feedback.ts:28-29,104`, `override-suggester.ts:19-20`
- Delete: `chart-review-platform/guidelines/`

These five callers don't use `guidelineDir()` — they hand-roll `path.join(... "guidelines" ...)`. Update each to use `guidelineDir(taskId)` from `domain/rubric/index.js`.

- [ ] **Step 1: Update each of the 5 files**

Replace local `guidelinesRoot()` helpers and inline paths with:

```typescript
import { guidelineDir } from "./domain/rubric/index.js";

const guidelinePath = guidelineDir(taskId);
```

(Adjust import path as needed for each file's location.)

- [ ] **Step 2: Run full server test suite**

```bash
pnpm vitest run app/server/__tests__/
```

Expected: PASS.

- [ ] **Step 3: grep for residual references**

```bash
grep -rn '"guidelines"\|/guidelines/\|CHART_REVIEW_GUIDELINES_ROOT' app lib tools 2>/dev/null
```

Expected: empty (or only comments / changelog mentions).

- [ ] **Step 4: Verify the legacy tree contains nothing referenced**

```bash
ls guidelines/lung-cancer-phenotype/
```

Expected: only leftover legacy YAML criteria, keyword_sets, code_sets, edge_cases.yaml that the loader no longer reads.

- [ ] **Step 5: Delete the legacy tree** *(confirm with user before running — destructive)*

```bash
rm -rf chart-review-platform/guidelines/
```

- [ ] **Step 6: Final smoke test**

Restart the dev server, open a lung-cancer review, verify criteria, keyword highlighting, code lookups, edge-case tooltips, exemplars all render.

- [ ] **Step 7: Commit**

```bash
git add -u
git commit -m "chore: delete legacy guidelines/ tree; skill is the single source"
```

---

## Self-Review Checklist

Before handing this plan off:

**Spec coverage:**
- ✅ Criteria — already in skill, no change needed
- ✅ keyword_sets — Task 1 (loader) + Task 5 (data migration)
- ✅ code_sets — Task 2 + Task 6
- ✅ edge_cases — Task 3 + Task 7
- ✅ exemplars — Task 4 (loader); data already in skill
- ✅ meta.yaml — Task 9
- ✅ versions/ + maturity.json + pilots/ + sampling.json — Task 10
- ✅ drafts — Task 11
- ✅ residual hand-rolled paths — Task 12
- ✅ legacy tree deletion — Task 12 step 5

**Type consistency:**
- All loader functions return existing types from `skill-bundle.ts` (`KeywordSet`, `CodeSet`, `EdgeCase`).
- `OperationalLayer` shape unchanged — only its source paths change.

**Risks:**
- Task 9 changes `guidelineDir()` semantics — this is the riskiest single change. The full server test suite must pass before Task 10 begins.
- Task 11's draft env-var hack replacement requires threading a `dirOverride` parameter through all four operational loaders. This is mechanical but touches Task 1-4 signatures.
