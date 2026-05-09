# Skill restructure to conform to Anthropic's "Complete Guide to Building Skills"

> **For agentic workers:** Use superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Restructure the `lung_cancer_phenotype` skill so it follows the conventions in Anthropic's guide: kebab-case folder name matching the `name:` field, supporting content under `references/` (the third-level progressive disclosure target), and `SKILL.md` slimmed to procedure + explicit pointers + examples + troubleshooting.

**Two changes:**
1. **Layout**: `criteria/` and `operational/` → `references/criteria/` and `references/{keyword_sets, code_sets, edge_cases.yaml, exemplars}/`. `meta.yaml` moves under `references/` too. The skill root holds `SKILL.md` + `references/` only.
2. **Name**: `lung_cancer_phenotype` → `lung-cancer-phenotype` (kebab-case). Folder, `task_id`, server constants, two review-state directories.

## Tasks

### Task 1: Move content under references/, rename folder

Single `git mv` pass. The reviews/ directories rename in lockstep.

- [ ] **Step 1**

```bash
cd "/Users/xinghe/Desktop/Chart Review Agents/chart-review-platform"

# Within the skill: criteria/ + operational/ + meta.yaml → references/
mkdir -p .claude/skills/lung_cancer_phenotype/references
git mv .claude/skills/lung_cancer_phenotype/criteria      .claude/skills/lung_cancer_phenotype/references/criteria
git mv .claude/skills/lung_cancer_phenotype/operational/keyword_sets .claude/skills/lung_cancer_phenotype/references/keyword_sets
git mv .claude/skills/lung_cancer_phenotype/operational/code_sets    .claude/skills/lung_cancer_phenotype/references/code_sets
git mv .claude/skills/lung_cancer_phenotype/operational/edge_cases.yaml .claude/skills/lung_cancer_phenotype/references/edge_cases.yaml
git mv .claude/skills/lung_cancer_phenotype/operational/exemplars   .claude/skills/lung_cancer_phenotype/references/exemplars
git mv .claude/skills/lung_cancer_phenotype/meta.yaml               .claude/skills/lung_cancer_phenotype/references/meta.yaml
rmdir .claude/skills/lung_cancer_phenotype/operational

# Folder rename: kebab-case
git mv .claude/skills/lung_cancer_phenotype .claude/skills/lung-cancer-phenotype

# Reviews directories
git mv reviews/patient_easy_nsclc_01/lung_cancer_phenotype reviews/patient_easy_nsclc_01/lung-cancer-phenotype
git mv reviews/patient_neg_hard_01/lung_cancer_phenotype   reviews/patient_neg_hard_01/lung-cancer-phenotype
```

- [ ] **Step 2: Verify layout**

```bash
find .claude/skills/lung-cancer-phenotype -type f | sort
ls reviews/patient_easy_nsclc_01/
```

Expected: SKILL.md at root + everything else under references/ (meta.yaml, criteria/×11, keyword_sets/×3, code_sets/×1, edge_cases.yaml, exemplars/×1).

### Task 2: Update server-side loaders

`loadSkillBundle` and `loadOperationalLayer` now read from `references/`. `meta.yaml` lives under `references/` too.

- [ ] **Step 1**: Update `app/server/skill-bundle.ts`:
  - `loadSkillBundle`: read `references/meta.yaml` (not `meta.yaml`); read `references/criteria/*.yaml` (not `criteria/*.yaml`)
  - `loadOperationalLayer`: read from `references/{keyword_sets, code_sets, edge_cases.yaml, exemplars}/` (drop `operational/` prefix)

- [ ] **Step 2**: Update test seeds in `app/server/__tests__/skill-bundle.test.ts` and `app/server/__tests__/bundle-compiler.test.ts` to write to the new layout.

- [ ] **Step 3**: Run skill-bundle tests:

```bash
cd chart-review-platform/app && npm test -- skill-bundle
```

(File-load issue locally; will pass in clean env.)

### Task 3: Rename `task_id` in active code

Active code paths only — historical docs/specs/plans not touched.

- [ ] **Step 1**: Update `app/server/server.ts:64` `DEFAULT_TASK_ID`:

```ts
const DEFAULT_TASK_ID =
  process.env.CHART_REVIEW_TASK_ID ?? "lung-cancer-phenotype";
```

- [ ] **Step 2**: Update `app/server/authoring.ts` SYSTEM_PROMPT to reference the new id (drop the explicit `lung_cancer_phenotype` exemplar mention; the skill-creator meta-skill will be added later).

- [ ] **Step 3**: Update test files:
  - `app/server/__tests__/bundle-compiler.test.ts` — replace literal `lung_cancer_phenotype` with `lung-cancer-phenotype`
  - `app/server/__tests__/compose-agent.test.ts` — replace
  - `app/server/__tests__/rule-store.test.ts` — replace
  - `lib/tests/test_agent_lab_extractor.py` — replace
  - `lib/tests/test_contracts.py` — replace

### Task 4: Rewrite SKILL.md per guide

- [ ] **Step 1**: Replace `.claude/skills/lung-cancer-phenotype/SKILL.md` with the new content (see plan body — frontmatter with strong trigger phrases, slim procedure, explicit `references/` pointers, two worked examples, troubleshooting).

### Task 5: Smoke

- [ ] **Step 1**: TS test suite

```bash
cd chart-review-platform/app && npm test 2>&1 | tail -8
```

- [ ] **Step 2**: Python test suite

```bash
cd chart-review-platform/lib && python3 -m pytest tests/ 2>&1 | tail -3
```

- [ ] **Step 3**: Verify no `lung_cancer_phenotype` left in active code

```bash
grep -rln "lung_cancer_phenotype" chart-review-platform/app/server chart-review-platform/lib/chart_review --include="*.ts" --include="*.py"
```

Expected: empty.

- [ ] **Step 4**: Final commit summary
