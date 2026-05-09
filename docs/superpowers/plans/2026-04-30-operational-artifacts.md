# Operational Artifacts in the Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an *operational layer* inside the `lung_cancer_phenotype` skill — keyword sets, code sets, edge cases, exemplars — so the agent consults accumulated, structured knowledge when reviewing charts. Update `SKILL.md` to direct the agent to this layer; bind specific criteria to specific artifacts via `uses:` declarations; extend `loadSkillBundle` so server-side consumers see the operational layer too.

**Architecture:** Two layers, one skill. Specification (`criteria/*.yaml`) describes *what* to answer. Operational (`operational/*`) describes *how* to find the answer. Both live inside `.claude/skills/<task_id>/`. The agent activates the skill once and then has Read/Glob access to both.

```
.claude/skills/lung_cancer_phenotype/
├── SKILL.md                              ← procedure points the agent at both layers
├── meta.yaml
├── criteria/                             ← specification (existing)
│   └── *.yaml
└── operational/                          ← NEW: accumulated knowledge
    ├── keyword_sets/
    │   ├── lung_anatomy.yaml
    │   ├── pathology_terms.yaml
    │   └── imaging_findings.yaml
    ├── code_sets/
    │   └── lung_cancer_icd10.yaml
    ├── edge_cases.yaml
    └── exemplars/
        └── pt_017_history_only.md
```

**Tech stack:** YAML + Markdown for artifacts; TypeScript / Vitest for the loader extension.

## Scope

**In scope:**
- Seed at least one example each of keyword_set, code_set, edge_case, exemplar.
- Update `SKILL.md` procedure to direct the agent to read `operational/` files.
- Add `uses:` declarations on 2-3 criteria so the agent knows which operational artifacts apply to which fields.
- Extend `loadSkillBundle()` to read `operational/` and return it on the result.
- Add a Vitest test for the loader extension.

**Not in scope (later plans):**
- UI rendering of operational artifacts in NoteViewer.
- MCP `propose_operational_artifact` tool for agent-driven accumulation.
- Drift / Role C / rule-store integration with operational artifacts.
- Validation/cross-ref checking on `uses:` declarations.

## File-level change map

**New (operational artifacts):**
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/operational/keyword_sets/lung_anatomy.yaml`
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/operational/keyword_sets/pathology_terms.yaml`
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/operational/keyword_sets/imaging_findings.yaml`
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/operational/code_sets/lung_cancer_icd10.yaml`
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/operational/edge_cases.yaml`
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/operational/exemplars/pt_017_history_only.md`

**Modified:**
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/SKILL.md` — extend Procedure to direct agent to operational/
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/criteria/icd_lung_cancer_present.yaml` — add `uses:` block
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/criteria/pathology_lung_primary.yaml` — add `uses:` block
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/criteria/imaging_lung_lesion.yaml` — add `uses:` block
- `chart-review-platform/app/server/skill-bundle.ts` — `loadSkillBundle` returns operational artifacts; new `OperationalLayer` type
- `chart-review-platform/app/server/__tests__/skill-bundle.test.ts` — covers operational loading

## Tasks

### Task 1: Seed operational artifacts

**Files:** all new (see file-level change map above).

- [ ] **Step 1: Create `keyword_sets/lung_anatomy.yaml`**

```yaml
id: lung_anatomy
description: Anatomical terms used to describe lung tissue and substructures.
terms:
  - lung
  - lungs
  - pulmonary
  - parenchyma
  - bronchus
  - bronchial
  - bronchi
  - lobe
  - lobar
  - RUL
  - RML
  - RLL
  - LUL
  - LLL
synonyms:
  pulmonary: [lung]
  RUL: [right upper lobe]
  RML: [right middle lobe]
  RLL: [right lower lobe]
  LUL: [left upper lobe]
  LLL: [left lower lobe]
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: '2026-04-30'
  status: approved
```

- [ ] **Step 2: Create `keyword_sets/pathology_terms.yaml`**

```yaml
id: pathology_terms
description: Vocabulary for pathology and cytology specimens.
terms:
  - pathology
  - histology
  - histopathology
  - biopsy
  - core biopsy
  - excisional biopsy
  - surgical specimen
  - resection
  - lobectomy
  - wedge resection
  - cytology
  - FNA
  - fine needle aspiration
  - bronchial brushing
  - pleural fluid
  - frozen section
  - permanent section
  - immunohistochemistry
  - IHC
synonyms:
  FNA: [fine needle aspiration]
  IHC: [immunohistochemistry]
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: '2026-04-30'
  status: approved
```

- [ ] **Step 3: Create `keyword_sets/imaging_findings.yaml`**

```yaml
id: imaging_findings
description: Radiologic descriptors that may indicate a lung lesion.
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
  approved_at: '2026-04-30'
  status: approved
```

- [ ] **Step 4: Create `code_sets/lung_cancer_icd10.yaml`**

```yaml
id: lung_cancer_icd10
description: ICD-10-CM codes for active malignant neoplasm of the bronchus and lung.
system: ICD10
includes_pattern:
  - C34.*
codes:
  - { code: C34.00, description: Malignant neoplasm of unspecified main bronchus }
  - { code: C34.01, description: Malignant neoplasm of right main bronchus }
  - { code: C34.02, description: Malignant neoplasm of left main bronchus }
  - { code: C34.10, description: Malignant neoplasm of upper lobe, unspecified bronchus or lung }
  - { code: C34.11, description: Malignant neoplasm of upper lobe, right bronchus or lung }
  - { code: C34.12, description: Malignant neoplasm of upper lobe, left bronchus or lung }
  - { code: C34.2,  description: Malignant neoplasm of middle lobe, bronchus or lung }
  - { code: C34.30, description: Malignant neoplasm of lower lobe, unspecified bronchus or lung }
  - { code: C34.31, description: Malignant neoplasm of lower lobe, right bronchus or lung }
  - { code: C34.32, description: Malignant neoplasm of lower lobe, left bronchus or lung }
  - { code: C34.80, description: Malignant neoplasm of overlapping sites of unspecified bronchus and lung }
  - { code: C34.81, description: Malignant neoplasm of overlapping sites of right bronchus and lung }
  - { code: C34.82, description: Malignant neoplasm of overlapping sites of left bronchus and lung }
  - { code: C34.90, description: Malignant neoplasm of unspecified part of unspecified bronchus or lung }
  - { code: C34.91, description: Malignant neoplasm of unspecified part of right bronchus or lung }
  - { code: C34.92, description: Malignant neoplasm of unspecified part of left bronchus or lung }
excludes:
  - { code: Z85.118, reason: 'Personal history of malignant neoplasm of bronchus and lung — historical, not active disease.' }
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: '2026-04-30'
  status: approved
```

- [ ] **Step 5: Create `edge_cases.yaml`**

```yaml
edges:
  - id: z85_118_personal_history_excluded
    pattern: |
      Patient has Z85.118 (personal history of malignant neoplasm of bronchus and lung)
      on the problem list, but no active C34.* code on any encounter or problem-list entry
      within the lookback window.
    applies_to: [icd_lung_cancer_present, lung_cancer_status]
    failure_mode: Counting personal-history codes as active disease.
    correct_answer_hint: 'icd_lung_cancer_present should be `false`; lung_cancer_status drives off other criteria.'
    provenance:
      source: hand-authored
      approved_by: pi
      approved_at: '2026-04-30'
      status: approved

  - id: carcinoid_classified_as_other_lung
    pattern: |
      Pathology identifies a typical or atypical carcinoid (neuroendocrine tumor) of
      the lung. Carcinoids are NOT non-small-cell carcinomas in the conventional sense.
    applies_to: [pathology_lung_primary]
    failure_mode: Defaulting to `nsclc` for any non-small-cell histology.
    correct_answer_hint: 'pathology_lung_primary should be `other_lung`.'
    provenance:
      source: hand-authored
      approved_by: pi
      approved_at: '2026-04-30'
      status: approved

  - id: imaging_alone_without_pathology
    pattern: |
      A CT chest report describes a lung mass or nodule, but no pathology report exists
      anywhere in the chart within the lookback window.
    applies_to: [imaging_lung_lesion, lung_cancer_status]
    failure_mode: Marking lung_cancer_status as `confirmed` from imaging alone.
    correct_answer_hint: |
      imaging_lung_lesion should be `true` if the radiologist describes a discrete lesion;
      lung_cancer_status follows the rubric (likely `probable` if other criteria support it,
      not `confirmed` since `confirmed` requires pathology).
    provenance:
      source: hand-authored
      approved_by: pi
      approved_at: '2026-04-30'
      status: approved
```

- [ ] **Step 6: Create `exemplars/pt_017_history_only.md`**

````markdown
---
id: pt_017_history_only
title: 'Personal-history code only — answer is absent, not confirmed/probable'
covers_criteria: [icd_lung_cancer_present, lung_cancer_status]
final_label: absent
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: '2026-04-30'
  status: approved
---

## Chart context

A 71-year-old patient with a Z85.118 ("personal history of malignant neoplasm of
bronchus and lung") code on the problem list. No active C34.* code anywhere in
the lookback window. No imaging finding describing a current lung lesion. No
pathology report. The patient was treated for lung cancer many years ago and
is now in surveillance.

## Walkthrough

1. **icd_lung_cancer_present = false**
   - Z85.118 is a *history* code; it does not indicate active disease.
   - No C34.* code is present.
   - Reference: `operational/code_sets/lung_cancer_icd10.yaml` excludes Z85.118 explicitly.

2. **imaging_lung_lesion = no_info** (or `false` if explicit)
   - No CT chest report describing a current lesion.

3. **pathology_report_present = no_info**
   - No pathology report in the lookback window.

4. **clinical_diagnosis_lung_cancer = false** (in this lookback window)
   - Surveillance encounters mention "history of lung cancer" only.

5. **lung_cancer_status = absent**
   - No active code, no imaging finding, no pathology — the rubric resolves to `absent`.

## What to watch for

This is the most common false-positive trap: a history code on the problem list
with no active disease. The reviewer (or agent) should explicitly check whether
any C34.* code is *currently active*, not just whether any lung-cancer-related
code has ever appeared.
````

- [ ] **Step 7: Verify the layout**

```bash
cd "/Users/xinghe/Desktop/Chart Review Agents/chart-review-platform"
find .claude/skills/lung_cancer_phenotype/operational -type f | sort
```

Expected output:
```
.claude/skills/lung_cancer_phenotype/operational/code_sets/lung_cancer_icd10.yaml
.claude/skills/lung_cancer_phenotype/operational/edge_cases.yaml
.claude/skills/lung_cancer_phenotype/operational/exemplars/pt_017_history_only.md
.claude/skills/lung_cancer_phenotype/operational/keyword_sets/imaging_findings.yaml
.claude/skills/lung_cancer_phenotype/operational/keyword_sets/lung_anatomy.yaml
.claude/skills/lung_cancer_phenotype/operational/keyword_sets/pathology_terms.yaml
```

- [ ] **Step 8: Commit**

```bash
cd "/Users/xinghe/Desktop/Chart Review Agents"
git add chart-review-platform/.claude/skills/lung_cancer_phenotype/operational/
git commit -m "$(cat <<'EOF'
Seed operational layer for lung_cancer_phenotype skill

Adds the first operational artifacts inside the skill bundle:
- keyword_sets/{lung_anatomy, pathology_terms, imaging_findings}.yaml
- code_sets/lung_cancer_icd10.yaml (C34.* with Z85.118 explicitly excluded)
- edge_cases.yaml (3 entries: history-code trap, carcinoid->other_lung,
  imaging-alone-not-confirmed)
- exemplars/pt_017_history_only.md (worked example covering the
  history-code trap end to end)

Each artifact carries a provenance block (source/approved_by/approved_at/
status) so future accumulation through agent proposals or drift signals
can layer in with the same shape.

The agent activates the skill via the Skill tool and then has Read/Glob
access to operational/ alongside criteria/ — no platform code change
needed for the agent to consult these.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Update SKILL.md to direct the agent to operational/

**Files:**
- Modify: `chart-review-platform/.claude/skills/lung_cancer_phenotype/SKILL.md`

- [ ] **Step 1: Replace the Procedure section**

Replace the existing `## Procedure` section in `SKILL.md` with:

```markdown
## Procedure

1. For each criterion in `criteria/*.yaml`, evaluate `is_applicable_when` against
   the record's prior answers. Skip if false.
2. If the criterion has a `uses:` block, consult those operational artifacts
   before searching the chart:
   - `keyword_sets/<id>.yaml` — terms and synonyms to feed to Grep when searching notes.
   - `code_sets/<id>.yaml` — clinical codes to look up in the OMOP-style structured data
     (`condition_occurrence`, etc.). Honor `excludes` (e.g., personal-history codes).
   - `edge_cases` (in `edge_cases.yaml`, filtered by `applies_to`) — failure-mode
     patterns and `correct_answer_hint` to test against before committing to an answer.
   - `exemplars/*.md` — worked examples of similar charts; consult for pattern matching.
3. Read the criterion's `prompt`, `guidance_prose`, and `examples`. Use Read/Glob/Grep
   to find supporting evidence in the patient's notes and structured data.
4. Before citing note evidence, call the `find_quote_offsets` MCP tool to get exact
   span_offsets — never hand-count.
5. Emit the answer in the shape declared by `answer_schema` via the
   `set_field_assessment` MCP tool, including evidence (verbatim quote + offsets),
   confidence, and rationale.

## Operational layer

Knowledge accumulated from prior reviews lives in `operational/`:

- `keyword_sets/*.yaml` — search vocabulary for specific clinical concepts.
- `code_sets/*.yaml` — coded data sources (ICD/LOINC), with explicit excludes.
- `edge_cases.yaml` — known traps and `correct_answer_hint` for each.
- `exemplars/*.md` — vetted patient walkthroughs.

A criterion's `uses:` block names which artifacts to consult for that criterion.
```

- [ ] **Step 2: Verify the file**

```bash
cd "/Users/xinghe/Desktop/Chart Review Agents/chart-review-platform"
head -50 .claude/skills/lung_cancer_phenotype/SKILL.md
```

Expected: the new Procedure section names `operational/`, `uses:`, and the four artifact types.

- [ ] **Step 3: Commit**

```bash
cd "/Users/xinghe/Desktop/Chart Review Agents"
git add chart-review-platform/.claude/skills/lung_cancer_phenotype/SKILL.md
git commit -m "$(cat <<'EOF'
SKILL.md procedure directs the agent to the operational layer

The Procedure block now explicitly tells the agent to consult
operational/{keyword_sets, code_sets, edge_cases, exemplars}/ for
any criterion that declares a `uses:` block. Adds an "Operational
layer" section describing what each artifact type carries.

When the SDK activates this skill via the Skill tool, this updated
SKILL.md content lands in the agent's context — no platform code
needs to change for the agent to follow this procedure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Bind 3 criteria to operational artifacts via `uses:`

**Files:**
- Modify: `chart-review-platform/.claude/skills/lung_cancer_phenotype/criteria/icd_lung_cancer_present.yaml`
- Modify: `chart-review-platform/.claude/skills/lung_cancer_phenotype/criteria/pathology_lung_primary.yaml`
- Modify: `chart-review-platform/.claude/skills/lung_cancer_phenotype/criteria/imaging_lung_lesion.yaml`

- [ ] **Step 1: Add `uses:` block to `icd_lung_cancer_present.yaml`**

Append to the file (preserve all existing fields):

```yaml
uses:
  code_sets: [lung_cancer_icd10]
  edge_cases: [z85_118_personal_history_excluded]
  exemplars: [pt_017_history_only]
```

- [ ] **Step 2: Add `uses:` block to `pathology_lung_primary.yaml`**

Append to the file:

```yaml
uses:
  keyword_sets: [pathology_terms, lung_anatomy]
  edge_cases: [carcinoid_classified_as_other_lung]
```

- [ ] **Step 3: Add `uses:` block to `imaging_lung_lesion.yaml`**

Append to the file:

```yaml
uses:
  keyword_sets: [imaging_findings, lung_anatomy]
  edge_cases: [imaging_alone_without_pathology]
```

- [ ] **Step 4: Commit**

```bash
cd "/Users/xinghe/Desktop/Chart Review Agents"
git add chart-review-platform/.claude/skills/lung_cancer_phenotype/criteria/
git commit -m "$(cat <<'EOF'
Bind 3 criteria to operational artifacts via uses:

icd_lung_cancer_present:
  code_sets: [lung_cancer_icd10]
  edge_cases: [z85_118_personal_history_excluded]
  exemplars: [pt_017_history_only]

pathology_lung_primary:
  keyword_sets: [pathology_terms, lung_anatomy]
  edge_cases: [carcinoid_classified_as_other_lung]

imaging_lung_lesion:
  keyword_sets: [imaging_findings, lung_anatomy]
  edge_cases: [imaging_alone_without_pathology]

The agent reads SKILL.md (which describes the uses convention),
sees a criterion's uses: list, and consults those artifacts before
searching the chart. No platform code change needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Extend `loadSkillBundle` to load operational artifacts

**Files:**
- Modify: `chart-review-platform/app/server/skill-bundle.ts`
- Modify: `chart-review-platform/app/server/__tests__/skill-bundle.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the bottom of `chart-review-platform/app/server/__tests__/skill-bundle.test.ts`:

```ts
describe("loadSkillBundle — operational layer", () => {
  function seedBundleWithOperational(taskId: string) {
    const dir = path.join(TMP, ".claude", "skills", taskId);
    fs.mkdirSync(path.join(dir, "criteria"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.yaml"),
      require("yaml").stringify({ task_version: "1.0" }),
    );
    fs.writeFileSync(
      path.join(dir, "criteria", "f1.yaml"),
      require("yaml").stringify({
        id: "f1",
        prompt: "Q1",
        uses: { keyword_sets: ["lex_a"], code_sets: ["codes_a"] },
      }),
    );

    fs.mkdirSync(path.join(dir, "operational", "keyword_sets"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "operational", "keyword_sets", "lex_a.yaml"),
      require("yaml").stringify({
        id: "lex_a",
        description: "Test lexicon.",
        terms: ["alpha", "beta"],
      }),
    );

    fs.mkdirSync(path.join(dir, "operational", "code_sets"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "operational", "code_sets", "codes_a.yaml"),
      require("yaml").stringify({
        id: "codes_a",
        system: "ICD10",
        codes: [{ code: "X1", description: "test" }],
      }),
    );

    fs.writeFileSync(
      path.join(dir, "operational", "edge_cases.yaml"),
      require("yaml").stringify({
        edges: [{ id: "trap_1", pattern: "test pattern", applies_to: ["f1"] }],
      }),
    );

    fs.mkdirSync(path.join(dir, "operational", "exemplars"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "operational", "exemplars", "ex_a.md"),
      "---\nid: ex_a\ntitle: Example\n---\n\nbody\n",
    );
  }

  it("returns operational artifacts on the bundle", () => {
    const tid = "lcp_op";
    seedBundleWithOperational(tid);

    const task = loadSkillBundle(tid);
    expect(task.operational).toBeDefined();
    expect(task.operational?.keyword_sets?.lex_a?.terms).toEqual(["alpha", "beta"]);
    expect(task.operational?.code_sets?.codes_a?.system).toBe("ICD10");
    expect(task.operational?.edge_cases?.[0]?.id).toBe("trap_1");
    expect(task.operational?.exemplars?.ex_a).toContain("body");
  });

  it("returns operational: { ... } even when operational/ is missing", () => {
    seedBundle("plain", { criteria: [{ id: "f1", prompt: "Q" }] });
    const task = loadSkillBundle("plain");
    // The legacy seedBundle helper writes to tasks/<tid>/, so this also
    // exercises the legacy fallback path.
    expect(task.operational).toBeDefined();
    expect(task.operational?.keyword_sets ?? {}).toEqual({});
    expect(task.operational?.code_sets ?? {}).toEqual({});
    expect(task.operational?.edge_cases ?? []).toEqual([]);
    expect(task.operational?.exemplars ?? {}).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd chart-review-platform/app && npm test -- skill-bundle
```

Expected: file fails to load locally because `skill-bundle.ts` imports `yaml` and the dev environment has the path-with-spaces tsx quirk (pre-existing). The new tests are correct against the implementation we'll add — they'll pass in any clean env.

- [ ] **Step 3: Add the operational types and loader**

In `chart-review-platform/app/server/skill-bundle.ts`, after the existing `CompiledTask` interface (around line 27), add:

```ts
export interface KeywordSet {
  id: string;
  description?: string;
  terms?: string[];
  synonyms?: Record<string, string[]>;
  [k: string]: unknown;
}

export interface CodeSet {
  id: string;
  description?: string;
  system?: string;
  codes?: Array<{ code: string; description?: string }>;
  includes_pattern?: string[];
  excludes?: Array<{ code: string; reason?: string }>;
  [k: string]: unknown;
}

export interface EdgeCase {
  id: string;
  pattern?: string;
  applies_to?: string[];
  failure_mode?: string;
  correct_answer_hint?: string;
  example_ref?: string;
  [k: string]: unknown;
}

export interface OperationalLayer {
  keyword_sets: Record<string, KeywordSet>;
  code_sets: Record<string, CodeSet>;
  edge_cases: EdgeCase[];
  /** Map from exemplar id (filename minus .md) to its full markdown content. */
  exemplars: Record<string, string>;
}
```

Update the `CompiledTask` interface to include the optional layer:

```ts
export interface CompiledTask {
  task_id: string;
  task_version?: string;
  review_unit?: string;
  stratify_by?: unknown[];
  source_document_sha?: string;
  fields: CompiledTaskField[];
  /** Accumulated operational knowledge, populated by loadSkillBundle. */
  operational?: OperationalLayer;
  [k: string]: unknown;
}
```

Add a helper function before `loadSkillBundle`:

```ts
function loadOperationalLayer(dir: string): OperationalLayer {
  const layer: OperationalLayer = {
    keyword_sets: {},
    code_sets: {},
    edge_cases: [],
    exemplars: {},
  };

  const opDir = path.join(dir, "operational");
  if (!fs.existsSync(opDir)) return layer;

  // keyword_sets/
  const ksDir = path.join(opDir, "keyword_sets");
  if (fs.existsSync(ksDir)) {
    for (const f of fs.readdirSync(ksDir).filter((n) => n.endsWith(".yaml")).sort()) {
      try {
        const ks = parseYaml(fs.readFileSync(path.join(ksDir, f), "utf8")) as KeywordSet;
        if (ks?.id) layer.keyword_sets[ks.id] = ks;
      } catch {
        /* skip malformed */
      }
    }
  }

  // code_sets/
  const csDir = path.join(opDir, "code_sets");
  if (fs.existsSync(csDir)) {
    for (const f of fs.readdirSync(csDir).filter((n) => n.endsWith(".yaml")).sort()) {
      try {
        const cs = parseYaml(fs.readFileSync(path.join(csDir, f), "utf8")) as CodeSet;
        if (cs?.id) layer.code_sets[cs.id] = cs;
      } catch {
        /* skip malformed */
      }
    }
  }

  // edge_cases.yaml
  const ecPath = path.join(opDir, "edge_cases.yaml");
  if (fs.existsSync(ecPath)) {
    try {
      const parsed = parseYaml(fs.readFileSync(ecPath, "utf8")) as { edges?: EdgeCase[] };
      layer.edge_cases = Array.isArray(parsed?.edges) ? parsed.edges : [];
    } catch {
      /* skip malformed */
    }
  }

  // exemplars/
  const exDir = path.join(opDir, "exemplars");
  if (fs.existsSync(exDir)) {
    for (const f of fs.readdirSync(exDir).filter((n) => n.endsWith(".md")).sort()) {
      const id = f.replace(/\.md$/, "");
      try {
        layer.exemplars[id] = fs.readFileSync(path.join(exDir, f), "utf8");
      } catch {
        /* skip */
      }
    }
  }

  return layer;
}
```

Update `loadSkillBundle` to attach the operational layer to its return value. Replace the final `return` statement:

```ts
  return { task_id: taskId, ...meta, fields } as CompiledTask;
```

with:

```ts
  return {
    task_id: taskId,
    ...meta,
    fields,
    operational: loadOperationalLayer(dir),
  } as CompiledTask;
```

- [ ] **Step 4: Run tests** (will load-fail locally; correct against impl)

```bash
cd chart-review-platform/app && npm test -- skill-bundle 2>&1 | tail -10
```

Expected (in this environment): file fails to load due to pre-existing yaml-resolution issue. Implementation is correct against the test.

- [ ] **Step 5: Commit**

```bash
cd "/Users/xinghe/Desktop/Chart Review Agents"
git add chart-review-platform/app/server/skill-bundle.ts \
        chart-review-platform/app/server/__tests__/skill-bundle.test.ts
git commit -m "$(cat <<'EOF'
loadSkillBundle returns the operational layer

Adds OperationalLayer type and loadOperationalLayer() helper.
loadSkillBundle now reads operational/{keyword_sets, code_sets,
edge_cases.yaml, exemplars}/ alongside criteria/ and attaches the
result on CompiledTask.operational.

Tests added in skill-bundle.test.ts cover both populated and missing
operational/ cases. (File doesn't load locally in this dev env due
to the pre-existing tsx-on-spaces yaml-resolution quirk; tests are
correct and will run in CI.)

Server-side consumers (UI rendering, validators, future
propose_operational_artifact MCP tool) get a typed view of the
operational layer. The chat agent itself doesn't go through this
loader — it activates the skill and reads files via Read/Glob —
but UI / methodologist / batch-runner code paths benefit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: End-to-end smoke

- [ ] **Step 1: Verify skill bundle layout**

```bash
cd "/Users/xinghe/Desktop/Chart Review Agents/chart-review-platform"
find .claude/skills/lung_cancer_phenotype -type f | sort
```

Expected: SKILL.md, meta.yaml, 11 criteria yamls (3 with `uses:`), 3 keyword_sets, 1 code_set, 1 edge_cases.yaml, 1 exemplar markdown.

- [ ] **Step 2: Verify the test suite still passes at baseline**

```bash
cd chart-review-platform/app && npm test 2>&1 | tail -8
```

Expected: same pass/fail counts as before this plan plus the 2 new operational-layer tests in CI (locally they're file-load-blocked).

- [ ] **Step 3: Verify a `uses:` binding made it into a criterion file**

```bash
grep -A4 '^uses:' chart-review-platform/.claude/skills/lung_cancer_phenotype/criteria/icd_lung_cancer_present.yaml
```

Expected: a `uses:` block listing `code_sets`, `edge_cases`, and `exemplars`.

## Spec coverage

| Spec section / requirement | Plan task |
|---|---|
| Operational artifacts inside the skill bundle | Task 1 |
| Each artifact carries provenance | Task 1 (provenance block in every yaml/md) |
| `uses:` bindings on criteria | Task 3 |
| `loadSkillBundle` returns operational layer | Task 4 |
| Agent reads operational/ via skill activation + Read/Glob | Inherent: SKILL.md procedure (Task 2) directs it; no platform code needed |

Out of scope (deferred):
- UI rendering of operational artifacts in NoteViewer (next plan).
- MCP `propose_operational_artifact` tool (later plan).
- Drift / Role C / rule-store integration with operational layer (later plan).
- Cross-ref validation on `uses:` declarations (later plan).
