# Skill Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the platform's skills to follow the main-orchestrator + sibling-sub-skills pattern (per `2026-05-03-skill-architecture-design.md`), and migrate the `lung-cancer-phenotype` rubric content from `guidelines/lung-cancer-phenotype/` into a phenotype scope-skill at `.claude/skills/chart-review-lung-cancer-phenotype/`.

**Architecture:** 7 cosmetic renames + 1 main-skill rewrite + 1 new phenotype scope-skill (with markdown-with-YAML-frontmatter criterion files) + platform-code path updates. Skill content (rubric) separates from platform-runtime state (maturity, pilots).

**Tech Stack:** Bash + Python for content migration, TypeScript edits to `app/server/skill-bundle.ts` and adjacent platform code, vitest for regression coverage, the existing iter_011 (haiku) pilot as the validation oracle.

**Source spec:** `docs/superpowers/specs/2026-05-03-skill-architecture-design.md`. Read it before starting.

**Validation oracle:** after the migration, re-run a single-agent pilot on `patient_easy_neg_01` with `claude-haiku-4.5`. Output (`agent_1.json` field_assessments) must be functionally equivalent to iter_011's output — same field count, similar answers, citations present. Different criterion file format/location must not change agent behavior.

---

## File structure (after migration)

```
.claude/skills/
├── chart-review/                          # main orchestrator (rewrite SKILL.md)
│   ├── SKILL.md                           # orchestrator + Quick Reference
│   └── references/
│       ├── evidence-citation.md           # universal citation discipline
│       ├── mcp-tools.md                   # chart_review_state MCP usage
│       ├── lifecycle.md                   # phase definitions
│       └── reliability-metrics.md         # κ vs ICC vs Jaccard etc.
├── chart-review-author/                   # was: guideline-authoring
├── chart-review-build/                    # was: chart-review-guideline-builder
├── chart-review-calibrate/                # was: guideline-calibration
├── chart-review-improve/                  # was: guideline-improvement
├── chart-review-cohort/                   # was: cohort-feedback
├── chart-review-copilot/                  # was: review-copilot
├── chart-review-methods/                  # was: methods-section-drafting
└── chart-review-lung-cancer-phenotype/    # NEW phenotype scope-skill
    ├── SKILL.md
    └── references/
        ├── case-definition.md
        ├── criteria/<field_id>.md         # one per criterion
        ├── code_sets/<id>.md
        ├── edge_cases/<id>.md
        └── exemplars/<id>.md
```

Mutable platform state stays at `guidelines/lung-cancer-phenotype/` (maturity.json, pilots/, sampling.json, lock_test/, versions/).

---

## Phase A — Skill renames (mechanical)

### Task A.1: Rename 7 skill directories

**Files:**
- Modify: `.claude/skills/` (rename 7 subdirectories)

- [ ] **Step 1: Rename, one by one, with git mv**

  ```bash
  cd "/Users/xinghe/Desktop/Chart Review Agents/chart-review-platform"
  git mv .claude/skills/guideline-authoring        .claude/skills/chart-review-author
  git mv .claude/skills/chart-review-guideline-builder  .claude/skills/chart-review-build
  git mv .claude/skills/guideline-calibration      .claude/skills/chart-review-calibrate
  git mv .claude/skills/guideline-improvement      .claude/skills/chart-review-improve
  git mv .claude/skills/cohort-feedback            .claude/skills/chart-review-cohort
  git mv .claude/skills/review-copilot             .claude/skills/chart-review-copilot
  git mv .claude/skills/methods-section-drafting   .claude/skills/chart-review-methods
  ls .claude/skills/
  ```

  Expected output: 8 directories all prefixed `chart-review-*` (the existing `chart-review` plus the 7 renamed siblings).

- [ ] **Step 2: Update each renamed skill's `name:` frontmatter to match the new folder name**

  For each renamed skill, edit its `SKILL.md` to update the `name:` field in the YAML frontmatter to match the new kebab-case folder name. Example:

  ```yaml
  # .claude/skills/chart-review-author/SKILL.md
  ---
  name: chart-review-author        # was: guideline-authoring
  description: ...                  # leave as-is for now (Phase B updates triggers)
  ---
  ```

  Repeat for the 6 other renamed skills.

- [ ] **Step 3: Find and update any string references to the old skill names in platform code**

  ```bash
  grep -rn "guideline-authoring\|guideline-calibration\|guideline-improvement\|cohort-feedback\|review-copilot\|methods-section-drafting\|chart-review-guideline-builder" \
    --include="*.ts" --include="*.tsx" --include="*.py" --include="*.md" \
    | grep -v "node_modules\|docs/\|.git" | head -30
  ```

  Update each occurrence to the new kebab-case name. Be careful: in the docs (`docs/`), historical references to the old names may be intentional (the names tell the migration story). Do NOT touch `docs/` — only update active platform code references.

  Common match locations: server-side skill loaders, frontmatter in test fixtures, status-bar config.

- [ ] **Step 4: Run server tests**

  ```bash
  cd app && npx vitest run server/
  ```

  Expected: all tests still pass. If any fail because they hard-coded the old skill name, update the test.

- [ ] **Step 5: Commit**

  ```bash
  git add -A
  git commit -m "$(cat <<'EOF'
  refactor(skills): rename 7 skills with chart-review-* prefix

  Cosmetic rename only — content unchanged. Aligns with the
  main-orchestrator + sibling-sub-skills pattern from
  2026-05-03-skill-architecture-design.md.

  guideline-authoring             → chart-review-author
  chart-review-guideline-builder  → chart-review-build
  guideline-calibration           → chart-review-calibrate
  guideline-improvement           → chart-review-improve
  cohort-feedback                 → chart-review-cohort
  review-copilot                  → chart-review-copilot
  methods-section-drafting        → chart-review-methods

  chart-review (main) untouched here; Phase B rewrites its SKILL.md.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Phase B — Main skill rewrite

### Task B.1: Rewrite `chart-review/SKILL.md` as orchestrator

**Files:**
- Modify: `.claude/skills/chart-review/SKILL.md`

- [ ] **Step 1: Read the current SKILL.md**

  Capture key content currently inside `chart-review/SKILL.md` that should remain (the citation discipline, the MCP tool usage instructions, the hard rules). These will move to `references/` files in Phase C; for now, keep them inline in SKILL.md until the references are created.

- [ ] **Step 2: Write the new SKILL.md**

  Use this template (matches the design doc's recommended shape):

  ````markdown
  ---
  name: chart-review
  description: >
    Comprehensive chart-review methodology for clinical phenotyping research.
    Reviews patient EHR against locked rubrics, supports the full lifecycle
    from draft to publication. Triggers on: review chart, abstract case,
    review patient, phenotype, chart abstraction, clinical phenotyping,
    is this lung cancer, dual-agent review, IRB-defensible chart review.
  metadata:
    author: chart-review-platform
    version: "0.2.0"
  ---

  # Chart Review: Universal Phenotyping Methodology

  This is the orchestrator skill. It activates broadly on chart-review
  language and either dispatches to a process sub-skill or runs the
  review workflow itself.

  ## Sibling skills (siblings under .claude/skills/)

  | Skill | Activates on | What it does |
  |---|---|---|
  | `chart-review-author`     | "draft a phenotype", "create chart-review protocol" | Draft a new phenotype skill from a research objective |
  | `chart-review-build`      | "build a guideline with me", interactive drafting    | Interactive builder for a phenotype skill |
  | `chart-review-calibrate`  | "calibrate this draft", "compute kappa"              | Compute κ + lock-test eligibility |
  | `chart-review-improve`    | "improve guideline", "cluster overrides"             | Cluster adjudicated gaps into rule proposals |
  | `chart-review-cohort`     | "what's drifting", "cohort feedback"                 | Cohort-level analysis of locked-guideline reviews |
  | `chart-review-copilot`    | reviewer's review-time questions                     | Read-only review-time helper |
  | `chart-review-methods`    | "draft methods section"                              | Draft methods-section text from study artifacts |

  Phenotype scope-skills follow the pattern `chart-review-<noun>-phenotype` (e.g.,
  `chart-review-lung-cancer-phenotype`). They auto-activate when the user
  names the phenotype.

  ## Lifecycle (per docs/OVERVIEW.md §3)

  ```
  draft → piloted → calibrated → locked → deployed → (issues) → new draft
  ```

  Pilot orchestration is a *platform* action (UI button → server-side
  `startPilotIteration` → batch run with N agents using THIS chart-review
  skill in batch mode). Adjudication is a *human* action (the reviewer
  picks a classification in the UI; the chart-review-copilot skill answers
  reviewer questions during it).

  ## Universal references

  - `references/evidence-citation.md` — citation discipline (REQUIRED for
    every set_field_assessment call; absence-as-evidence patterns)
  - `references/mcp-tools.md` — using chart_review_state MCP tools
  - `references/lifecycle.md` — phase definitions
  - `references/reliability-metrics.md` — κ vs ICC vs Jaccard vs etc.

  Phenotype skills cross-reference these by relative path.

  ## Active phenotype resolution

  When the chart-review skill is active, determine the active phenotype by:
  1. **Explicit user mention** — user names the phenotype ("review for lung cancer")
  2. **Active platform context** — the `active_task_id` in the v2 client; the pilot's
     `task_id` in batch mode
  3. **Patient meta hint** — `corpus/patients/<pid>/meta.json:category` (last resort)

  Once the active phenotype is known, look for the corresponding skill at
  `.claude/skills/chart-review-<phenotype>-phenotype/`. Read its `SKILL.md`
  and consult its `references/criteria/<field_id>.md` files.

  ## Review process (per-patient, batch mode or interactive)

  *(Existing review-process content from the original SKILL.md goes here
  — read criteria, search evidence, anchor offsets, commit assessments.
  In Phase C this content moves to `references/`; until then it stays
  inline.)*
  ````

  Adapt the existing review-process content into the bottom section without
  losing any of the F1 fix from `eb2ff48` (REQUIRED evidence citation).

- [ ] **Step 3: Smoke-test agent-roles + skill registry endpoints**

  ```bash
  curl -s http://localhost:3001/api/agent-roles | python3 -c "import sys,json; print('ok' if 'presets' in json.load(sys.stdin) else 'fail')"
  ```

  Server should still respond (skill-bundle code paths unaffected). If anything
  errors, the renames in Phase A missed a reference.

- [ ] **Step 4: Commit**

  ```bash
  git add .claude/skills/chart-review/SKILL.md
  git commit -m "$(cat <<'EOF'
  feat(chart-review-skill): rewrite SKILL.md as orchestrator

  Adopts the claude-seo main-skill-with-Quick-Reference pattern.
  The chart-review skill now declares its sibling sub-skills, the
  phenotype-scope-skill convention, and the lifecycle phases. Existing
  review-process content kept inline; Phase C will move it to references/.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Phase C — Shared references in main skill

### Task C.1: Create `chart-review/references/` with the four shared docs

**Files:**
- Create: `.claude/skills/chart-review/references/evidence-citation.md`
- Create: `.claude/skills/chart-review/references/mcp-tools.md`
- Create: `.claude/skills/chart-review/references/lifecycle.md`
- Create: `.claude/skills/chart-review/references/reliability-metrics.md`

- [ ] **Step 1: Extract evidence-citation discipline from current `chart-review/SKILL.md`**

  Move the F1 evidence requirement section (the long block we added in commit `eb2ff48`) from inline in SKILL.md into `references/evidence-citation.md`. Keep the same content; add a one-line cross-reference in SKILL.md ("See `references/evidence-citation.md` for the citation discipline").

- [ ] **Step 2: Create `references/mcp-tools.md`**

  Document the chart_review_state MCP tools (set_field_assessment, find_quote_offsets, select_evidence, get_review_state, set_summary). Pull existing content from SKILL.md if present; otherwise write a 1-page reference covering tool names, parameter shapes, and validation rules.

- [ ] **Step 3: Create `references/lifecycle.md`**

  Brief reference: the four phases (draft, piloted, calibrated, locked, deployed) and what triggers transitions. Cross-reference `docs/OVERVIEW.md` and `docs/superpowers/specs/2026-05-03-post-mvp-blueprint.md` for the full discussion.

- [ ] **Step 4: Create `references/reliability-metrics.md`**

  Brief reference for the typed reliability dispatch: which metric per criterion type (κ for binary/nominal, weighted κ for ordinal, ICC for continuous, Jaccard for sets, date-tolerance for dates). Cross-reference the post-MVP blueprint §6 for full discussion.

- [ ] **Step 5: Trim chart-review SKILL.md to point at the references**

  After moving content out, SKILL.md should be ~60 lines: frontmatter + Quick Reference table + lifecycle pointer + "see references/" pointers.

- [ ] **Step 6: Commit**

  ```bash
  git add .claude/skills/chart-review/
  git commit -m "$(cat <<'EOF'
  feat(chart-review-skill): split shared content into references/

  Progressive-disclosure refactor. chart-review/SKILL.md is now ~60 lines
  (orchestrator + Quick Reference); long-form content moves to:
  - references/evidence-citation.md (the F1 fix; mandatory citation rules)
  - references/mcp-tools.md
  - references/lifecycle.md
  - references/reliability-metrics.md

  Sibling sub-skills (and phenotype scope-skills) cross-reference these.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Phase D — Migrate `lung-cancer-phenotype` to skill format

### Task D.1: Scaffold the new phenotype skill directory

**Files:**
- Create: `.claude/skills/chart-review-lung-cancer-phenotype/SKILL.md`
- Create: `.claude/skills/chart-review-lung-cancer-phenotype/references/case-definition.md`
- Create directories: `references/criteria/`, `references/code_sets/`, `references/edge_cases/`, `references/exemplars/`

- [ ] **Step 1: Make the directory structure**

  ```bash
  cd "/Users/xinghe/Desktop/Chart Review Agents/chart-review-platform"
  mkdir -p .claude/skills/chart-review-lung-cancer-phenotype/references/{criteria,code_sets,edge_cases,exemplars}
  ```

- [ ] **Step 2: Write SKILL.md**

  ```markdown
  ---
  name: chart-review-lung-cancer-phenotype
  description: >
    Lung cancer phenotyping rubric. Activates when reviewing patient charts
    for lung cancer status (confirmed / probable / absent). Triggers on:
    lung cancer, lung cancer phenotype, NSCLC, SCLC, pulmonary malignancy,
    is this lung cancer, lung cancer status, lung cancer review.
  metadata:
    guideline_id: lung-cancer-phenotype
    case_definition: confirmed | probable | absent
    leaf_criteria_count: 7
    derived_criteria_count: 4
    state_anchor: guidelines/lung-cancer-phenotype/maturity.json
  ---

  # Lung Cancer Phenotyping Rubric

  ## Scope

  Use when reviewing a patient's chart against the lung cancer phenotype
  case definition. See `references/case-definition.md` for the full
  case definition (what counts as confirmed / probable / absent).

  ## Criteria

  This rubric has 7 leaf criteria + 4 derived criteria. Each leaf is a
  separate file under `references/criteria/`; the chart-review skill
  discovers them by directory listing.

  ### Leaf criteria
  - `pathology_report_present`
  - `pathology_lung_primary`
  - `cytology_supports_lung_primary`
  - `imaging_lung_lesion`
  - `oncologist_lung_cancer_diagnosis_in_note`
  - `icd_lung_cancer_present`
  - `lowest_hemoglobin_in_window`

  ### Derived criteria (computed automatically)
  - `pathology_confirms_lung_cancer`
  - `clinical_diagnosis_lung_cancer`
  - `pre_treatment_anemia_present`
  - `lung_cancer_status` (final label)

  ## Code sets
  - `references/code_sets/lung_cancer_icd10.md` — C34.* family

  ## Edge cases
  - `references/edge_cases/z85_118_personal_history_excluded.md`
  - `references/edge_cases/imaging_alone_without_pathology.md`
  - `references/edge_cases/carcinoid_classified_as_other_lung.md`

  ## Exemplars
  - (one per file under `references/exemplars/`)

  ## How to use this rubric

  When the chart-review skill is active and this skill is loaded:
  1. Read `references/case-definition.md` for the label semantics
  2. For each leaf criterion in `references/criteria/`, read the file and
     apply the rules to the active patient
  3. Cite evidence per `skills/chart-review/references/evidence-citation.md`
  4. Commit answers via `set_field_assessment` (chart_review_state MCP)

  ## Lifecycle metadata

  This skill is the **portable rubric**. Platform-runtime state for THIS
  deployment lives at `guidelines/lung-cancer-phenotype/`:
  - `maturity.json` — current state (draft / piloted / calibrated / locked / deployed)
  - `pilots/iter_NNN/` — iteration history
  - `sampling.json` — cohort assignment
  - `lock_test/`, `versions/`, `canary/`
  ```

- [ ] **Step 3: Write `references/case-definition.md`**

  Convert the existing `guidelines/lung-cancer-phenotype/meta.yaml` content into prose:
  - the case definition (what each label means)
  - inclusion criteria
  - exclusion criteria
  - any rubric-wide guidance (e.g., review window, source-document priority)

  Read `guidelines/lung-cancer-phenotype/meta.yaml` first; rewrite as markdown.

- [ ] **Step 4: Commit the scaffold**

  ```bash
  git add .claude/skills/chart-review-lung-cancer-phenotype/
  git commit -m "feat(skills): scaffold chart-review-lung-cancer-phenotype scope-skill"
  ```

### Task D.2: Migrate criterion YAMLs to markdown-with-frontmatter

**Files:**
- Create (×11, one per criterion): `.claude/skills/chart-review-lung-cancer-phenotype/references/criteria/<field_id>.md`
- Source: `guidelines/lung-cancer-phenotype/criteria/<field_id>.yaml` (do not delete yet)

- [ ] **Step 1: Write a one-shot migration helper**

  Save as `/tmp/migrate-criterion.py`:

  ```python
  import sys, json, yaml, hashlib
  from pathlib import Path

  src_dir = Path("guidelines/lung-cancer-phenotype/criteria")
  dst_dir = Path(".claude/skills/chart-review-lung-cancer-phenotype/references/criteria")
  dst_dir.mkdir(parents=True, exist_ok=True)

  STRUCTURAL_FIELDS = ["answer_schema", "cardinality", "derivation",
                       "is_applicable_when", "is_final_output", "group",
                       "time_window", "uses"]

  def schema_hash(d):
      structural = {k: d.get(k) for k in STRUCTURAL_FIELDS if k in d}
      blob = json.dumps(structural, sort_keys=True)
      return hashlib.sha256(blob.encode()).hexdigest()[:16]

  for src in sorted(src_dir.glob("*.yaml")):
      d = yaml.safe_load(src.read_text())
      fid = d.get("id") or src.stem
      h = schema_hash(d)
      front_keys = ["field_id", "prompt", "answer_schema", "cardinality",
                    "time_window", "group", "is_applicable_when",
                    "derivation", "is_final_output", "schema_hash", "uses"]
      front = {"field_id": fid, "schema_hash": h}
      for k in ["prompt", "answer_schema", "cardinality", "time_window",
                "group", "is_applicable_when", "derivation",
                "is_final_output", "uses"]:
          if k in d:
              front[k] = d[k]
      gp = d.get("guidance_prose") or {}
      eg = d.get("extraction_guidance")

      lines = ["---"]
      lines.append(yaml.safe_dump(front, sort_keys=False).strip())
      lines.append("---")
      lines.append("")
      lines.append(f"# Criterion: {fid}")
      lines.append("")
      if gp.get("definition"):
          lines.append("## Definition")
          lines.append("")
          lines.append(gp["definition"].strip())
          lines.append("")
      if eg:
          lines.append("## Extraction guidance")
          lines.append("")
          lines.append(str(eg).strip())
          lines.append("")
      if gp.get("examples"):
          lines.append("## Examples")
          lines.append("")
          lines.append(gp["examples"].strip())
          lines.append("")
      if gp.get("tier_rationale"):
          lines.append("## Rationale")
          lines.append("")
          lines.append(gp["tier_rationale"].strip())
          lines.append("")
      out = (dst_dir / f"{fid}.md")
      out.write_text("\n".join(lines))
      print(f"  wrote {out} (schema_hash={h})")
  ```

- [ ] **Step 2: Run it**

  ```bash
  cd "/Users/xinghe/Desktop/Chart Review Agents/chart-review-platform"
  python3 /tmp/migrate-criterion.py
  ls .claude/skills/chart-review-lung-cancer-phenotype/references/criteria/
  ```

  Expected output: 11 `.md` files (one per criterion), each with YAML frontmatter (field_id + schema_hash + structural fields) and a markdown body (Definition, Extraction guidance, Examples, Rationale).

- [ ] **Step 3: Spot-check one converted file**

  Open `references/criteria/oncologist_lung_cancer_diagnosis_in_note.md` and confirm the structure looks reasonable: prose intact, schema_hash present, frontmatter parses as YAML.

- [ ] **Step 4: Commit**

  ```bash
  git add .claude/skills/chart-review-lung-cancer-phenotype/references/criteria/
  git commit -m "feat(skills): migrate 11 criteria to markdown-with-frontmatter"
  ```

### Task D.3: Migrate code sets, edge cases, exemplars

**Files:**
- Create (×N each): code_sets/, edge_cases/, exemplars/ markdown files

- [ ] **Step 1: List source files**

  ```bash
  ls guidelines/lung-cancer-phenotype/code_sets/ \
      guidelines/lung-cancer-phenotype/edge_cases.yaml \
      guidelines/lung-cancer-phenotype/exemplars/
  ```

  Note today's edge_cases is a SINGLE yaml file with multiple entries (`edges:`); split into one file per entry.

- [ ] **Step 2: Migrate code_sets**

  For each `guidelines/lung-cancer-phenotype/code_sets/<id>.yaml`, write a markdown file at `.claude/skills/chart-review-lung-cancer-phenotype/references/code_sets/<id>.md` with YAML frontmatter (id + version + source) and a markdown body listing the codes with their descriptions.

- [ ] **Step 3: Migrate edge_cases**

  Split `guidelines/lung-cancer-phenotype/edge_cases.yaml`'s `edges:` list into one file per entry under `references/edge_cases/<edge.id>.md`. Each file has frontmatter (id, applies_to, failure_mode) and prose body (pattern + correct_answer_hint).

- [ ] **Step 4: Migrate exemplars**

  For each `guidelines/lung-cancer-phenotype/exemplars/<id>.md`, copy verbatim to `.claude/skills/chart-review-lung-cancer-phenotype/references/exemplars/<id>.md`. They're already markdown.

- [ ] **Step 5: Commit**

  ```bash
  git add .claude/skills/chart-review-lung-cancer-phenotype/references/{code_sets,edge_cases,exemplars}/
  git commit -m "feat(skills): migrate code_sets, edge_cases, exemplars to skill references/"
  ```

---

## Phase E — Update platform code paths

### Task E.1: Add a phenotype-skill loader and use it for criteria reads

**Files:**
- Create: `app/server/phenotype-skill.ts`
- Modify: `app/server/skill-bundle.ts` (or wherever criterion files are read today)

- [ ] **Step 1: Read current criterion-loading code**

  ```bash
  grep -rn "criteria/.*\\.yaml\\|guidelineDir.*criteria\\|criteria/" app/server/*.ts | grep -v __tests__ | head
  ```

  Identify the canonical function that reads criterion YAML for a given task. Likely in `skill-bundle.ts` or a `tasks.ts`/`compiled-task.ts` analog.

- [ ] **Step 2: Add `phenotype-skill.ts` with skill-format-aware loading**

  ```typescript
  // app/server/phenotype-skill.ts
  import fs from "fs";
  import path from "path";
  import { parse as parseYaml } from "yaml";
  import { PLATFORM_ROOT } from "./patients.js";

  export interface CriterionFromSkill {
    field_id: string;
    schema_hash?: string;
    prompt?: string;
    answer_schema?: unknown;
    cardinality?: string;
    time_window?: string;
    group?: string;
    derivation?: string;
    is_applicable_when?: string;
    is_final_output?: boolean;
    uses?: { code_sets?: string[]; edge_cases?: string[]; exemplars?: string[]; keyword_sets?: string[] };
    guidance_prose?: { definition?: string; examples?: string; tier_rationale?: string };
    extraction_guidance?: string;
  }

  /** Resolve <task_id> to a skill directory under .claude/skills/. */
  export function phenotypeSkillDir(taskId: string): string {
    return path.join(PLATFORM_ROOT, ".claude", "skills", `chart-review-${taskId}-phenotype`);
  }

  /** Read all leaf+derived criteria for a phenotype skill. */
  export function loadPhenotypeCriteria(taskId: string): CriterionFromSkill[] {
    const dir = path.join(phenotypeSkillDir(taskId), "references", "criteria");
    if (!fs.existsSync(dir)) {
      return [];
    }
    const out: CriterionFromSkill[] = [];
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith(".md")) continue;
      const txt = fs.readFileSync(path.join(dir, f), "utf8");
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(txt);
      if (!m) continue;
      const front = parseYaml(m[1]) as CriterionFromSkill;
      // Optionally parse the body as guidance_prose.definition etc; for now,
      // the frontmatter is the load-bearing part for runtime use.
      out.push(front);
    }
    return out;
  }
  ```

- [ ] **Step 3: Add a fallback to the legacy YAML directory**

  Until all phenotypes are migrated, keep the legacy reader and prefer the skill-format reader when the skill exists:

  ```typescript
  export function loadCriteria(taskId: string): CriterionFromSkill[] {
    const fromSkill = loadPhenotypeCriteria(taskId);
    if (fromSkill.length > 0) return fromSkill;
    // Fallback: legacy guidelines/<task>/criteria/*.yaml
    return loadLegacyCriteria(taskId);
  }
  ```

  This means: if the skill directory exists → use it. If not → fall back to today's `guidelines/<task>/criteria/*.yaml`. After the phenotype is migrated, the fallback is dead code.

- [ ] **Step 4: Replace call sites**

  Find all places in the server that read criterion YAML files, and route them through the new `loadCriteria(taskId)` function.

  ```bash
  grep -rn "guidelineDir.*criteria\\|readdir.*criteria\\|criteria/.*\\.yaml" app/server/*.ts | grep -v __tests__
  ```

  Update each. The compose-agent.ts userPrompt that says "Active guideline path: ..." should now pass the phenotype-skill directory path (`.claude/skills/chart-review-<task>-phenotype/`) when the skill exists.

- [ ] **Step 5: Run server tests**

  ```bash
  cd app && npx vitest run server/
  ```

  Expected: still green. If anything breaks, the fallback path may need adjustment.

- [ ] **Step 6: Commit**

  ```bash
  git add app/server/phenotype-skill.ts app/server/*.ts
  git commit -m "$(cat <<'EOF'
  feat(server): phenotype-skill loader with legacy YAML fallback

  loadCriteria(taskId) prefers the new skill-format directory at
  .claude/skills/chart-review-<task>-phenotype/references/criteria/
  and falls back to guidelines/<task>/criteria/*.yaml for unmigrated
  phenotypes. After all phenotypes migrate, the fallback becomes
  dead code.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

### Task E.2: Update agent userPrompt to point at the skill

**Files:**
- Modify: `app/server/runs.ts` (the userPrompt construction in `runOneAgent`)

- [ ] **Step 1: Locate the userPrompt that mentions guideline path**

  In `runOneAgent` (created in Task 3.2 of the original MVP plan), find:

  ```typescript
  const userPrompt = [
    `You are running in batch mode. Activate the \`chart-review\` skill.`,
    "",
    `Active patient: ${patientId}`,
    `Active guideline: ${taskId} (path: ${path.relative(PLATFORM_ROOT, guidelineDir(taskId))})`,
    ...
  ];
  ```

- [ ] **Step 2: Update to reference the phenotype skill when present**

  ```typescript
  import { phenotypeSkillDir } from "./phenotype-skill.js";

  const skillDir = phenotypeSkillDir(taskId);
  const usingSkillFormat = fs.existsSync(skillDir);
  const guidelinePathLine = usingSkillFormat
    ? `Active guideline: ${taskId} (skill: ${path.relative(PLATFORM_ROOT, skillDir)})`
    : `Active guideline: ${taskId} (legacy path: ${path.relative(PLATFORM_ROOT, guidelineDir(taskId))})`;

  const userPrompt = [
    `You are running in batch mode. Activate the \`chart-review\` skill.`,
    `If a skill named \`chart-review-${taskId}-phenotype\` exists, activate it as well — it provides the rubric scope.`,
    "",
    `Active patient: ${patientId}`,
    guidelinePathLine,
    ...
  ];
  ```

- [ ] **Step 3: Run the existing server suite + smoke-test**

  ```bash
  cd app && npx vitest run server/
  ```

  Then start a small pilot to verify the agent picks up the new skill at runtime.

- [ ] **Step 4: Commit**

  ```bash
  git add app/server/runs.ts
  git commit -m "feat(runs): point batch-mode agent at phenotype skill when present"
  ```

---

## Phase F — End-to-end validation

### Task F.1: Re-run a single-agent pilot on the migrated phenotype

**Files:**
- (no source changes — runtime test)

- [ ] **Step 1: Start a single-agent pilot**

  ```bash
  TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
    -H 'content-type: application/json' \
    -d '{"reviewer_id":"plan_executor"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

  curl -s -X POST http://localhost:3001/api/pilots/lung-cancer-phenotype \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d '{
      "patient_ids": ["patient_easy_neg_01"],
      "started_by": "skill_migration_test",
      "notes": "post-skill-migration validation",
      "agent_specs": [{"id":"agent_1","role_preset":"default","role_version":"v1","model":"anthropic/claude-haiku-4.5"}]
    }' | python3 -m json.tool
  ```

  Capture the iter_id and run_id.

- [ ] **Step 2: Wait for completion + inspect output**

  Poll until the run state is `complete` (use the same Bash run_in_background pattern from earlier sessions; ~90 seconds with haiku).

- [ ] **Step 3: Compare against iter_011's baseline**

  ```bash
  python3 << 'EOF'
  import json
  from pathlib import Path
  ROOT = Path("/Users/xinghe/Desktop/Chart Review Agents/chart-review-platform")

  def load(iter_id):
      m = json.loads((ROOT/"guidelines/lung-cancer-phenotype/pilots"/iter_id/"manifest.json").read_text())
      run_id = m["run_id"]
      d = json.loads((ROOT/"runs"/run_id/"per_patient/patient_easy_neg_01/agents/agent_1.json").read_text())
      return d["field_assessments"]

  baseline = {fa["field_id"]: fa for fa in load("iter_011")}
  new      = {fa["field_id"]: fa for fa in load("iter_NNN")}  # adjust
  print(f"baseline cells: {len(baseline)}, new cells: {len(new)}")
  for fid in sorted(set(baseline) | set(new)):
      b = baseline.get(fid, {})
      n = new.get(fid, {})
      same_answer = (b.get("answer") == n.get("answer"))
      both_cited = bool(b.get("evidence")) and bool(n.get("evidence"))
      print(f"  {fid}: answer_match={same_answer}  baseline_ev={len(b.get('evidence') or [])}  new_ev={len(n.get('evidence') or [])}")
  EOF
  ```

  Expected: same number of cells (or close); answers match within stochastic noise; citations present in both.

- [ ] **Step 4: If output is functionally equivalent, declare migration done**

  Commit a milestone marker:

  ```bash
  git commit --allow-empty -m "$(cat <<'EOF'
  milestone: skill-restructure complete — lung-cancer-phenotype migrated

  iter_NNN (post-migration) reproduces iter_011's outputs on
  patient_easy_neg_01 with claude-haiku-4.5. Skill-format reader
  active; legacy YAML fallback remains for unmigrated phenotypes.

  Next: criterion-level rerun build (uses schema_hash now in skill
  frontmatter).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 5: If output differs significantly, debug**

  Likely causes:
  - Markdown body lost prose details that influenced agent behavior → fix migration script
  - Skill not being activated → check userPrompt update in Task E.2
  - Code paths missed in Task E.1 → grep again for legacy YAML reads

  Debug, fix, retest.

---

## Phase G (optional) — Skill-creator validation

### Task G.1: Run skill-creator's validation tooling

- [ ] **Step 1: Invoke `document-skills:skill-creator` against the new phenotype skill**

  Use the validation features from the skill-creator skill. Ask it to verify:
  - SKILL.md has correct frontmatter
  - description includes trigger phrases
  - references/ structure is well-formed
  - No README.md inside skill folder
  - Folder name is kebab-case

- [ ] **Step 2: Apply any auto-corrections**

  If skill-creator finds issues, fix them. Most likely a small frontmatter format tweak.

- [ ] **Step 3: Commit if anything changed**

---

## Self-review

**Spec coverage check:**
- ✅ 7 renames → Phase A
- ✅ Main skill rewrite → Phase B
- ✅ Shared references → Phase C
- ✅ Phenotype skill scaffold → Phase D Task D.1
- ✅ Criteria migrated → Phase D Task D.2
- ✅ Code sets / edge cases / exemplars migrated → Phase D Task D.3
- ✅ Platform code updated → Phase E
- ✅ End-to-end validation → Phase F
- ✅ Skill-creator validation → Phase G (optional)

**Unhandled edge cases:**
- The `keyword_sets/` directory exists at `guidelines/lung-cancer-phenotype/keyword_sets/` and isn't in the migration plan above. Today's criteria reference them (`uses.keyword_sets`). Add migration of those to Phase D.3 if they're used at runtime.
- The `versions/` directory at `guidelines/lung-cancer-phenotype/versions/` holds historical snapshots. Stays where it is (mutable platform state).
- The `lock_test/` directory same — stays.

**Risks:**
- Phase E.1 fallback might mask migration bugs (skill-reader returns 0 entries → silently uses legacy). Mitigation: log a warning when the fallback is used, and require the validation in Phase F to confirm zero fallback triggers.
- Markdown frontmatter parser may differ from yaml-loader's strict parsing. Use the same `parse` function from `yaml` package both in the migration script and the loader.

---

## Execution handoff

**Plan complete and saved to** `docs/superpowers/plans/2026-05-03-skill-restructure.md`.

This plan is **smaller than the dual-agent MVP plan** (1–1.5 days vs ~3–4 days) and the tasks are mostly mechanical content moves. Subagent-driven execution is overkill; recommend **inline execution** with you reviewing the migration scripts before they run.

The next post-MVP build (criterion-level rerun) plugs directly into the new skill structure: `schema_hash` is already computed per-criterion in the markdown frontmatter, ready to drive carry-forward decisions.
