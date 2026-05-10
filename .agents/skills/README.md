# Skills Index

Skills in this folder are discovered flat by the Claude Agent SDK — they all sit
at this level on purpose. Subdirectories are not recursively scanned, so
**moving any skill into a subfolder will break SDK discovery.** This index
groups them by role so you can find what you need without reorganizing files.

There are 23 skills in three groups:
- **9 lifecycle skills** — used by every task, applied across all rubrics
- **12 phenotype rubrics** — one per study, each carrying its own criteria
- **2 placeholders** — scaffolding, candidates for cleanup

---

## Lifecycle skills (9)

The platform's procedural skills, applied across all rubrics. Activated by
description match in the user prompt.

| Skill | Phase | Role | SKILL.md | Total .md |
|---|---|---|---:|---:|
| `chart-review`           | runtime   | Universal reviewer — reads notes, cites evidence, commits via MCP   | 144 | 973 |
| `chart-review-author`    | DRAFT     | Batch rubric drafting from a published guideline / SOP / paper      | 190 | 277 |
| `chart-review-build`     | DRAFT     | Interactive 7-phase rubric authoring interview                      | 254 | 1000 |
| `chart-review-calibrate` | CALIBRATE | Computes per-criterion Cohen's κ from blind dual-reviewer samples   | 134 | 195 |
| `chart-review-improve`   | CALIBRATE | Clusters disagreements + override patterns into rubric edit proposals| 220 | 557 |
| `chart-review-copilot`   | VALIDATE  | Read-only copilot for the human reviewer during validation          | 175 | 175 |
| `chart-review-codify`    | POST-LOCK | Mines validated cohort for keyword / code / note-type anchors       | 88  | 134 |
| `chart-review-cohort`    | DEPLOY    | Cohort drift detection + override pattern analysis                  | 169 | 169 |
| `chart-review-methods`   | PUBLISH   | Drafts past-tense Methods section from locked rubric + κ stats      | 150 | 376 |

`SKILL.md` = the entry-point file's line count. `Total .md` = sum of all markdown
lines in the skill folder (entry point + references).

---

## Phenotype rubrics (12)

Each rubric is a self-contained skill with its own criteria, code sets,
keyword sets, and edge cases. Activated by phenotype mention in the user
prompt or by `Active guideline` line in batch-mode prompts.

Listed alphabetically. All are currently `draft` (none locked yet).

| Skill | Final output | Status | Version | Doc SHA | Criteria | Total .md |
|---|---|---|---|---|---:|---:|
| `chart-review-cha2ds2-vasc`         | `stroke_risk_tier`           | draft | 2026-05-07-draft | (none)         | 9   | 425 |
| `chart-review-dr-screening-p3`      | `dr_screening_concordance`   | draft | 2026-05-07-draft | (none)         | 5   | 306 |
| `chart-review-has-bled`             | `bleeding_risk_tier`         | draft | 2026-05-07-draft | (none)         | 11  | 517 |
| `chart-review-lung-cancer-labels`   | `lung_cancer_status`         | draft | 1.0              | (none)         | 0 ¹ | 6   |
| `chart-review-lung-cancer-phe-fixed`| `lung_cancer_status`         | draft | 0.1.0-draft      | (none)         | 5   | 375 |
| `chart-review-lung-cancer-phenotype`| `lung_cancer_status`         | draft | 2026-04-28       | `9ed4d2d4218d` | 11  | **4686** ² |
| `chart-review-nccn-nsclc-adjuvant`  | `adjuvant_chemo_concordance` | draft | 2026-05-07-draft | (none)         | 3   | 185 |
| `chart-review-pe-on-cta-p4`         | `pe_present`                 | draft | 2026-05-07-draft | (none)         | 4   | 233 |
| `chart-review-rucam-score-v2`       | `rucam_causality_category`   | draft | 2026-05-07-draft | (none)         | 7   | 376 |
| `chart-review-rucam-test`           | `rucam_final_score`          | draft | 0.1.0-draft      | (none)         | 8   | 464 |
| `chart-review-sepsis-3-p1`          | `sepsis_present`             | draft | 2026-05-07-draft | (none)         | 6   | 309 |
| `chart-review-statin-adherence-p2`  | `adherence_label`            | draft | 2026-05-07-draft | (none)         | 3   | 171 |

¹ `lung-cancer-labels` has no criteria yet — it's a labeling-only stub in
development; the parent rubric is `lung-cancer-phenotype`.

² `lung-cancer-phenotype` is the most-developed rubric in the repo by far —
~10× the markdown of any other phenotype, full source-document SHA pinned,
9 completed pilot iters under `pilots/`, and the only one with end-to-end
synthetic corpus + ground truth wired up.

---

## Placeholders (2)

| Skill | Status | Notes |
|---|---|---|
| `chart-review-task1` | (no meta.yaml) | 1 criterion, no `final_output` defined — appears to be scaffolding |
| `chart-review-test`  | (no meta.yaml) | Empty (no criteria, ~6 lines total) |

Neither has a `meta.yaml`, which means they're not registered as tasks by the
backend (`/api/tasks` only returns skills with valid metadata). Safe to delete
without affecting the SDK or the Studio.

---

## Reading the columns

| Column | Where it comes from | What it tells you |
|---|---|---|
| **Status** | `meta.yaml: status:` | Lifecycle stage. `draft` until LOCK page flips it; later: `calibrated`, `locked`, `deployed` |
| **Version** | `meta.yaml: manual_version:` | Free-text version string set by the methodologist; `2026-05-07-draft` is the build skill's default |
| **Doc SHA** | `meta.yaml: source_document_sha:` (truncated to 12 chars) | sha256 of the source clinical guideline document; pinned at draft time, immutable |
| **Criteria** | count of `references/criteria/*.md` | Number of atomic criteria defined |
| **Total .md** | `find <skill> -name '*.md' \| wc -l` | Total markdown lines across the entire skill folder — rough proxy for content depth |

---

## Anatomy of a phenotype skill folder

Every phenotype skill follows this shape:

```
chart-review-<task>-phenotype/
├── SKILL.md                   # entry point (name + description for activation)
├── meta.yaml                  # task config (time window, source priority, final output)
├── sampling.json              # which patients are dev / lock / cohort
├── pilots/                    # per-iter manifests + adjudications + critique
└── references/
    ├── case-definition.md     # human-readable phenotype definition
    ├── note_type_filters.md   # which note types each criterion uses
    ├── criteria/              # one .md per atomic criterion (frontmatter + body)
    ├── code_sets/             # ICD / OMOP / LOINC code lists
    ├── keyword_sets/          # search vocabularies
    ├── edge_cases/            # known traps + correct-answer hints
    └── exemplars/             # gold-labeled walkthroughs (optional)
```

## Anatomy of a lifecycle skill folder

Lifecycle skills are smaller — usually just a `SKILL.md` plus a `references/`
folder of universal methodology docs:

```
chart-review/
├── SKILL.md                          # entry point
└── references/
    ├── atomic-criteria.md            # what makes a criterion atomic
    ├── comprehensive-procedure.md    # the per-criterion review loop
    ├── evidence-citation.md          # how to cite quotes
    ├── examples.md                   # worked examples
    ├── lifecycle.md                  # draft → calibrated → locked → deployed
    ├── mcp-tools.md                  # MCP tool reference
    ├── reliability-metrics.md        # κ math, Landis-Koch buckets
    └── smart-search-procedure.md     # search strategy
```
