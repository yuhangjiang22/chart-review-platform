# Skill architecture — chart-review main + sub-skills

**Date:** 2026-05-03
**Status:** Proposed; awaiting sign-off
**Predecessor:** `2026-05-03-post-mvp-blueprint.md` (the lifecycle this architecture serves)
**Inspiration:** Anthropic's Building Skills guide (progressive disclosure, composability, description-driven activation) + the `claude-seo` repo's main-skill-with-sibling-sub-skills pattern

---

## Core insight from claude-seo

The `seo` skill is an **orchestrator** with three jobs:

1. **Broad-trigger description** — activates on any SEO-related user phrase
2. **Quick Reference table** — dispatches to specialized sub-skills by command (`/seo audit`, `/seo content`, etc.)
3. **Orchestration logic** — for compound commands like `/seo audit`, spawns multiple sub-skills in parallel based on detected signals

The sub-skills (`seo-audit`, `seo-content`, etc.) are **siblings** at the same level (not nested). Each has its own focused activation description AND can be dispatched by the orchestrator. Shared references (e.g., `eeat-framework.md`) live under the main `seo/references/` and sub-skills cross-reference them.

This is exactly the shape we want for chart-review, because it cleanly separates:
- **The orchestrator + universal methodology** (HOW to do chart review correctly)
- **Process sub-skills** (per-lifecycle-phase workflows)
- **Phenotype scope-skills** (the WHAT for a specific study)

The criterion-as-atomic-unit appears in three contexts:
1. **Guideline draft** — being edited inside a phenotype skill's `references/criteria/`
2. **Stored schema** — locked at a SHA inside a phenotype skill
3. **Annotation task** — read by the chart-review main + process sub-skills at runtime

The criterion lives *once*, in the phenotype skill's `references/criteria/`. Process sub-skills consume it; lifecycle metadata stays at `guidelines/<phenotype>/` (separate from the skill).

---

## The proposed structure

```
.claude/skills/
├── chart-review/                    # MAIN ORCHESTRATOR (rewrite SKILL.md)
│   ├── SKILL.md                     # broad activation + Quick Reference
│   └── references/
│       ├── evidence-citation.md     # universal citation discipline
│       ├── mcp-tools.md             # how to use chart_review_state MCP
│       ├── lifecycle.md             # phase definitions; cite OVERVIEW.md
│       └── reliability-metrics.md   # κ vs ICC vs Jaccard etc.
│
├── chart-review-author/             # PROCESS SUB-SKILL (rename: guideline-authoring)
│   ├── SKILL.md                     # "draft a new phenotype skill from spec"
│   └── references/
│       └── case-definition-template.md
│
├── chart-review-build/              # PROCESS SUB-SKILL (rename: chart-review-guideline-builder)
│   └── SKILL.md
│
├── chart-review-calibrate/          # PROCESS SUB-SKILL (rename: guideline-calibration)
│   └── SKILL.md
│
├── chart-review-improve/            # PROCESS SUB-SKILL (rename: guideline-improvement)
│   └── SKILL.md
│
├── chart-review-cohort/             # PROCESS SUB-SKILL (rename: cohort-feedback)
│   └── SKILL.md
│
├── chart-review-copilot/            # PROCESS SUB-SKILL (rename: review-copilot)
│   └── SKILL.md
│
├── chart-review-methods/            # PROCESS SUB-SKILL (rename: methods-section-drafting)
│   └── SKILL.md
│
├── chart-review-lung-cancer-phenotype/   # PHENOTYPE SCOPE-SKILL (NEW PATTERN)
│   ├── SKILL.md                     # "active when reviewing lung cancer charts"
│   └── references/
│       ├── case-definition.md       # what counts as lung cancer for this study
│       ├── criteria/                # one file per atomic criterion
│       │   ├── pathology_report_present.md
│       │   ├── oncologist_lung_cancer_diagnosis_in_note.md
│       │   └── ... (one per leaf + derived)
│       ├── code_sets/
│       │   └── lung_cancer_icd10.md
│       ├── edge_cases/
│       │   └── z85_118_personal_history_excluded.md
│       └── exemplars/
│           └── pt_017_history_only.md
│
└── chart-review-<other-phenotype>/  # FUTURE PHENOTYPE SCOPE-SKILLS
    └── ...
```

**8 skills total** — same count as today, just renamed for prefix consistency. The genuinely new thing is the phenotype scope-skill pattern (`chart-review-lung-cancer-phenotype/`); everything else is a cosmetic rename.

### Why "pilot" and "adjudicate" are NOT skills

**Running a pilot** is a platform action, not an agent skill. Methodologist clicks "Start iteration" in the v2 UI → `startPilotIteration` server function → spawns batch run with N agents using the chart-review skill in batch mode. The orchestration code is `app/server/pilots.ts` + `runs.ts`. The agent's behavior during a pilot is *the chart-review skill running in batch mode* — no separate skill needed.

**Adjudicating disagreements** is a human action. The methodologist reads two drafts, picks a classification (4-option taxonomy), types a suggested revision, clicks Submit. The *agent's* role during adjudication is answering the reviewer's questions ("why did Agent 1 say yes?") — that's `chart-review-copilot` (renamed from `review-copilot`). No new skill needed.

Mutable platform state stays at `guidelines/<phenotype>/`:

```
guidelines/lung-cancer-phenotype/
├── maturity.json                    # state machine
├── pilots/iter_NNN/                 # iteration history
├── sampling.json                    # cohort assignment
├── lock_test/                       # held-out validation
├── versions/                        # version-tagged snapshots
└── canary/                          # canary set (future)
```

The phenotype skill at `.claude/skills/chart-review-lung-cancer-phenotype/` is the **portable rubric**. The platform directory at `guidelines/lung-cancer-phenotype/` is the **deployment state**. They reference each other by name.

---

## Naming convention

All siblings share the `chart-review-*` prefix. Two sub-namespaces, distinguished by the third token:

- **Process sub-skills**: `chart-review-<verb>` (action). Examples: `chart-review-pilot`, `chart-review-adjudicate`, `chart-review-improve`.
- **Phenotype scope-skills**: `chart-review-<noun>-phenotype` (the rubric subject + the suffix `-phenotype` to disambiguate from process verbs). Examples: `chart-review-lung-cancer-phenotype`, `chart-review-medication-adherence-phenotype`.

This mirrors claude-seo's `seo-<verb>` pattern but adds the `-phenotype` suffix to keep scope-skills visually distinct from process-skills in the directory listing.

---

## Activation philosophy

Each skill has a focused `description` field that triggers it on the right user phrases:

| Skill | Triggers on |
|---|---|
| `chart-review` (main) | "review chart", "abstract case", any chart-review task — broad |
| `chart-review-author` | "draft a phenotype", "create a chart-review protocol" |
| `chart-review-build` | "build a guideline with me", interactive guideline drafting |
| `chart-review-calibrate` | "calibrate this draft", "compute kappa", "is this ready to lock" |
| `chart-review-improve` | "improve guideline", "cluster overrides into proposals" |
| `chart-review-cohort` | "what's drifting", "cohort feedback", "agent quality over time" |
| `chart-review-copilot` | reviewer's questions during validation ("why did Agent 1 say yes?") |
| `chart-review-methods` | "draft methods section", "write paper methods" |
| `chart-review-lung-cancer-phenotype` | "lung cancer", "phenotype lung cancer", "is this confirmed lung cancer" |

**Composition pattern:** when the user says *"review patient X for lung cancer"*, two skills auto-activate together:
1. `chart-review` (broad: "review chart")
2. `chart-review-lung-cancer-phenotype` (the named phenotype)

The main `chart-review` provides the methodology; the phenotype skill provides the scope. The reviewer's downstream actions (e.g., asking "why did agent say yes?") then activate `chart-review-copilot` on top.

For lifecycle-phase actions (calibrate / improve / cohort feedback / methods drafting), the relevant process sub-skill activates from its own trigger phrases — not from the main skill's invocation.

---

## What the main `chart-review` SKILL.md looks like

Following claude-seo's structure:

```markdown
---
name: chart-review
description: >
  Comprehensive chart-review methodology for clinical phenotyping research.
  Reviews patient EHR against locked rubrics, supports the full lifecycle
  from draft to publication. Triggers on: review chart, abstract case,
  phenotype, chart abstraction, clinical phenotyping, dual-agent review,
  guideline calibration, methods section, IRB-defensible chart review.
metadata:
  author: chart-review-platform
  version: "0.2.0"
---

# Chart Review: Universal Phenotyping Methodology

Orchestrates 7 process sub-skills + N phenotype scope-skills.

## Quick Reference

| Sub-skill | Activates on | What it does |
|---|---|---|
| `chart-review-author`     | "draft a phenotype", "create chart-review protocol"            | Draft a new phenotype skill from a research objective |
| `chart-review-build`      | "build a guideline with me", interactive drafting              | Interactive builder for a phenotype skill |
| `chart-review-calibrate`  | "calibrate this draft", "compute kappa"                        | Compute κ + lock-test eligibility |
| `chart-review-improve`    | "improve guideline", "cluster overrides"                       | Cluster adjudicated gaps into rule proposals |
| `chart-review-cohort`     | "what's drifting", "cohort feedback"                           | Cohort-level analysis of locked-guideline reviews |
| `chart-review-copilot`    | reviewer's review-time questions ("why did agent say yes?")    | Read-only review-time helper |
| `chart-review-methods`    | "draft methods section", "write paper methods"                 | Draft methods-section text from study artifacts |

(Pilot orchestration and adjudication are platform UI actions, not skills —
the chart-review skill itself runs in batch mode during pilots; the
chart-review-copilot skill activates during reviewer adjudication.)

## Lifecycle

The main skill enforces the linear ratchet (per `OVERVIEW.md` §3):

```
draft → piloted → calibrated → locked → deployed → (issues) → new draft
```

Each phase delegates to the appropriate process sub-skill. The active
phenotype scope-skill is determined from user context (mentioned phenotype)
or `guidelines/<phenotype>/maturity.json`.

## Universal references

- `references/evidence-citation.md` — when answering ANY criterion, cite
  evidence (this is the F1 fix from skill iteration on 2026-05-03)
- `references/mcp-tools.md` — using chart_review_state MCP tools
- `references/lifecycle.md` — phase semantics, what triggers what
- `references/reliability-metrics.md` — κ vs ICC vs Jaccard, when to use each

Sub-skills cross-reference these via path (e.g., a phenotype skill saying
"Read `skills/chart-review/references/evidence-citation.md` for citation
discipline").
```

---

## What a phenotype scope-skill SKILL.md looks like

```markdown
---
name: chart-review-lung-cancer-phenotype
description: >
  Lung cancer phenotyping rubric. Activates when reviewing patient charts
  for lung cancer status (confirmed / probable / absent). Triggers on:
  lung cancer, lung cancer phenotype, NSCLC, SCLC, pulmonary malignancy,
  is this lung cancer, lung cancer review, lung cancer status.
metadata:
  guideline_sha: <set at lock>
  maturity_state: locked            # mirrors guidelines/.../maturity.json
  case_definition: confirmed|probable|absent
  leaf_criteria_count: 7
  derived_criteria_count: 4
---

# Lung Cancer Phenotyping Rubric

## Scope

Use when reviewing a patient's chart against the lung cancer phenotype
case definition.

Read `references/case-definition.md` for the full case definition (what
counts as confirmed vs probable vs absent).

## Criteria

This rubric has 7 leaf criteria + 4 derived criteria. Each criterion is
a separate file under `references/criteria/`. The chart-review skill
discovers them by directory listing.

### Leaf criteria (require agent answers)

- `pathology_report_present` — see `references/criteria/pathology_report_present.md`
- `pathology_lung_primary` — see `references/criteria/pathology_lung_primary.md`
- ... (one bullet per leaf)

### Derived criteria (computed automatically)

- `pathology_confirms_lung_cancer` — derived from `pathology_lung_primary`
- `clinical_diagnosis_lung_cancer` — derived from oncologist + imaging
- `lung_cancer_status` — final label

## Code sets

- `references/code_sets/lung_cancer_icd10.md` — C34.* family

## Edge cases

- `references/edge_cases/z85_118_personal_history_excluded.md`
- `references/edge_cases/imaging_alone_without_pathology.md`
- `references/edge_cases/carcinoid_classified_as_other_lung.md`

## Exemplars

- `references/exemplars/pt_017_history_only.md`

## How to use this rubric

When the chart-review skill is active and this skill is loaded:
1. Read `references/case-definition.md` for context
2. For each leaf criterion in `references/criteria/`, read the file and
   apply the criterion's rules to the active patient
3. Cite evidence per the universal citation discipline at
   `skills/chart-review/references/evidence-citation.md`
4. Commit answers via `set_field_assessment`
```

---

## Criterion file format (atomic unit)

A criterion lives at `.claude/skills/chart-review-<phenotype>/references/criteria/<field_id>.md`. Format: markdown with YAML frontmatter, mirroring the existing YAML structure but in skill-format-friendly markdown:

```markdown
---
field_id: oncologist_lung_cancer_diagnosis_in_note
prompt: Does a treating oncologist or pulmonologist document lung cancer as the diagnosis?
answer_schema:
  enum: [yes, no, no_info]
cardinality: one
time_window: lookback_24mo
group: clinical_diagnosis
schema_hash: <computed at lock; sha256 over structural fields>
---

# Criterion: oncologist_lung_cancer_diagnosis_in_note

## Definition

A treating oncologist or pulmonologist documents lung cancer as the patient's
diagnosis (active or historical). Family history mentions, "rule out" language,
and provider-questioned diagnoses do **not** qualify.

## Decision rules

- If the treating oncologist or pulmonologist names lung cancer as the diagnosis
  AND commits to a treatment plan, answer `yes` — even when pathology is
  pending. *(Updated by proposal `prop-oncologist-absence-is-false` 2026-05-03.)*
- If no oncology or pulmonology note documents lung cancer, answer `no` — cite
  the chart's coverage as evidence (the most recent note showing only routine
  care).
- Use `no_info` only when an oncology note exists but its diagnostic statement
  is genuinely ambiguous.

## Examples

### Positive
- Oncology progress note: *"Patient with stage IIIA NSCLC, currently on
  cisplatin/etoposide"* → `yes`
- Onc note: *"Lung cancer, clinical stage IIIA, awaiting tissue confirmation"* →
  `yes` (working diagnosis with treatment commitment)

### Negative / absence
- No oncology or pulmonology note in chart, only PCP routine care →
  `no` (cite the most recent PCP note as evidence of coverage)
- *"Father with history of lung cancer"* → `no` (family history doesn't qualify)

### Ambiguous
- *"Considering lung cancer in differential, awaiting biopsy"* → `no_info`
  (provider not committed)

## Edge cases applicable to this criterion

- See `../edge_cases/imaging_alone_without_pathology.md`

## Schema-hash governance

The frontmatter `schema_hash` is computed over `answer_schema`, `cardinality`,
`time_window`, `group`, and references to other rubric resources. Edits to
the prose (Definition, Decision rules, Examples) do NOT change the hash; edits
to the answer enum or required output structure DO. The platform's
criterion-level rerun design (`docs/superpowers/specs/2026-05-03-criterion-level-rerun-design.md`)
governs what changes when this hash mutates.
```

This file is the atomic criterion-unit that the user identified. It exists in three contexts:
1. **Draft**: edited by `chart-review-author` or `chart-review-build` while the phenotype skill's maturity is `draft` or `piloted`
2. **Stored schema**: locked when `maturity_state: locked` and the SHA is recorded in `guidelines/<phenotype>/maturity.json`
3. **Annotation task**: read by `chart-review-pilot`, `chart-review-adjudicate`, etc. at runtime

The same file is the source of truth in all three.

---

## Migration plan

1. **Rename existing skills for consistency** (low-risk find/replace):
   - `guideline-authoring` → `chart-review-author`
   - `guideline-calibration` → `chart-review-calibrate`
   - `guideline-improvement` → `chart-review-improve`
   - `cohort-feedback` → `chart-review-cohort`
   - `review-copilot` → `chart-review-copilot`
   - `methods-section-drafting` → `chart-review-methods`
   - `chart-review-guideline-builder` → `chart-review-build`
   - `chart-review` stays (becomes the orchestrator)
   - **No new process sub-skills** — pilot orchestration and adjudication
     are platform UI actions, not skills.

2. **Update main `chart-review/SKILL.md`** to be an orchestrator with the Quick Reference table.

3. **Create `chart-review/references/`** with the universal docs (`evidence-citation.md`, `mcp-tools.md`, `lifecycle.md`, `reliability-metrics.md`). Move shared content out of individual sub-skills into here.

4. **Convert `guidelines/lung-cancer-phenotype/` rubric content into `.claude/skills/chart-review-lung-cancer-phenotype/`**:
   - YAML criteria → markdown-with-frontmatter under `references/criteria/`
   - YAML code sets → markdown under `references/code_sets/`
   - YAML edge cases → markdown under `references/edge_cases/`
   - Exemplars → markdown under `references/exemplars/`
   - Compute `schema_hash` per criterion (governs the criterion-level rerun design)
   - Author the phenotype skill's `SKILL.md` with description triggers

5. **Update platform code** (`app/server/skill-bundle.ts`, `compose-agent.ts`, etc.) to read criteria from the phenotype skill's `references/criteria/` instead of `guidelines/<phenotype>/criteria/`. Lifecycle metadata stays at `guidelines/<phenotype>/`.

6. **Validate**: re-run iter_011 (haiku, single-patient) against the new skill-format phenotype. Verify the agent reads criteria correctly, commits answers, and cites evidence. End-to-end test before declaring the migration done.

7. **Use skill-creator–style refinement**: after migration, the `chart-review-author` skill (and the new `chart-review-build`) should themselves invoke `document-skills:skill-creator` for creating new phenotype skills. Phenotype skill authoring becomes a wizard-driven flow rather than a YAML-editing chore.

---

## What this achieves

- **Criterion is now an atomic, addressable unit** in skill format, with progressive disclosure (frontmatter → body → edge case refs).
- **Phenotype skills are portable** — clone the folder, drop into another platform, it works.
- **Composition is clean** — `chart-review` (HOW) + process sub-skill (PHASE) + phenotype skill (WHAT) auto-activate together based on user phrasing.
- **Schema-hash governance** flows naturally from criterion file edits.
- **Skill-creator–style tooling** can refine phenotype skills (skill-of-skills pattern).
- **Consistent with claude-seo's proven main+sibling pattern**, which has been battle-tested at scale.

---

## Decisions to confirm with the user

1. **Naming**: `chart-review-<verb>` for processes, `chart-review-<noun>-phenotype` for scope-skills. Accept?
2. **Migration scope**: rename existing skills (low-risk) + create new `chart-review-pilot` and `chart-review-adjudicate` (medium effort) + migrate one phenotype to skill format as a proof (`chart-review-lung-cancer-phenotype`) (medium effort). All three in one sprint?
3. **Criterion file format**: markdown with YAML frontmatter (recommended) or pure YAML (today's format)?
4. **`-phenotype` suffix**: keep it for visual disambiguation, or rely on description-field activation alone?
5. **Order of operations**: skill rename + restructure FIRST, then criterion-level rerun build SECOND? Or reverse? My recommendation: skill restructure first — it makes criterion-level rerun's implementation cleaner because the schema_hash computation is over markdown frontmatter rather than YAML files.

---

## Out of scope (deferred)

- **Skill versioning beyond `metadata.version`**: how do you track skill evolution across guideline locks? For now, `metadata.guideline_sha` in the phenotype skill's frontmatter records the lock; further versioning machinery deferred.
- **Cross-phenotype skill reuse**: e.g., a `chart-review-icd10-codes` shared skill for ICD-10 lookup. Defer until 2+ phenotypes exist and need to share code-set logic.
- **Per-criterion sub-skills**: tempting to make EACH criterion a skill. Don't. Atomic criterion as a markdown file under `references/criteria/` is the right granularity. A sub-skill per criterion is over-engineering.
- **Skill-format adoption for cohort/sample-validation workflow**: stays as a process sub-skill (`chart-review-cohort`); the cohort run state stays at `cohorts/<study_id>/` (mutable platform state).
