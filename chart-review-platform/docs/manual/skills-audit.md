# Chart-Review Skills Audit

Audit of every skill under `.claude/skills/` in the chart-review-platform repo. Each section captures triggers, compose-with relationships, references inventory, and a health check.

All nine skills carry frontmatter version `0.2.0` (with the lung-cancer phenotype using a different metadata shape — see its section). Cross-skill references all resolve.

---

## chart-review (universal reviewer methodology)

**One-liner:** Reviews a patient's EHR against a phenotype rubric, committing answers via `chart_review_state` MCP tools.

**Version:** 0.2.0

**Triggers on:**
- "review this chart"
- "review this patient"
- "abstract this case"
- "is this lung cancer confirmed"
- "fill out the review form"
- "does this patient meet the criteria"
- any question that maps to a guideline criterion

**Composes with:** phenotype scope-skills (`chart-review-<noun>-phenotype`), e.g. `chart-review-lung-cancer-phenotype`.

**References:**
- `evidence-citation.md` — citation discipline (REQUIRED for every `set_field_assessment` call; absence-as-evidence patterns; OMOP-row citations)
- `examples.md` — worked examples on canonical criteria
- `lifecycle.md` — phase definitions (draft → piloted → calibrated → locked → deployed) and what triggers transitions
- `mcp-tools.md` — `chart_review_state` MCP tools (`set_field_assessment`, `find_quote_offsets`, `select_evidence`, `set_summary`, `get_review_state`) plus common error conditions
- `reliability-metrics.md` — which inter-rater metric to use per criterion type (κ, weighted κ, ICC, Jaccard, date-tolerance)

**Health:** ✓ healthy. All sibling skills referenced in the routing table exist; all cross-references resolve.

**Summary:** This is the orchestrator and universal methodology used at chart-review *time*. A human invokes this implicitly: when they ask the platform to review a patient, the agent loads `chart-review` plus the active phenotype scope-skill, walks the rubric criterion-by-criterion, anchors quotes via `find_quote_offsets`, and commits each answer through `set_field_assessment`. It is read-only on guideline files — rubric edits flow through the author/build/improve skills.

---

## chart-review-author (batch guideline drafter)

**One-liner:** Drafts a complete guideline package from a research objective and reference materials in one shot.

**Version:** 0.2.0

**Triggers on:**
- "draft a guideline"
- "create a chart review protocol"
- "design a phenotype rubric"
- "I want to validate [condition]"
- "set up a chart review for [study]"
- pasted SOP/paper/published-guideline excerpts asking for a structured rubric

**Composes with:** `chart-review-build` (interactive variant), `chart-review-calibrate` (validate the draft).

**References:**
- `examples.md` — worked examples (authoring from a pasted SOP; from a research objective alone)
- `troubleshooting.md` — fixes for too many criteria, paywalled references, conflicting sources, unknown codes
- `yaml-templates.md` — full field-by-field YAML templates for every guideline-package artifact

**Health:** ✓ healthy. Cross-references to `skills/chart-review/references/lifecycle.md` and `evidence-citation.md` resolve.

**Summary:** Used when a methodologist hands the agent a research question plus reference material (papers, SOPs, existing guidelines) and wants a full draft directory written at `guidelines/drafts/<task-id>/` in one pass. Produces `meta.yaml`, 5–12 criteria, and optionally seeded keyword/code sets and edge cases. A human picks this when they have all the source material in hand and prefer a fast batch draft over an interactive interview.

---

## chart-review-build (interactive guideline builder)

**One-liner:** Builds the same guideline package as `chart-review-author`, but step-by-step through conversation.

**Version:** 0.2.0

**Triggers on:**
- "build a guideline with me"
- "help me design a chart review protocol"
- "I want to draft this iteratively"
- "walk me through creating a rubric"
- Studio Authoring Builder flow

**Composes with:** subsumes `chart-review-author` for interactive use; composes with `chart-review-calibrate` and `chart-review-improve`.

**References:**
- `examples.md` — two worked walkthroughs (interactive from scratch; handling a user YAML edit during Phase 2)
- `interview-guide.md` — required question format template and 7-phase gathering checklist with "satisfied" conditions
- `yaml-templates.md` — full YAML templates for `meta.yaml`, criteria, code_sets, keyword_sets, and edge_cases

**Health:** ✓ healthy. Cross-reference to `skills/chart-review/references/lifecycle.md` resolves.

**Summary:** A two-phase conversational drafter — Phase 1 gathers protocol shape one multiple-choice question at a time with explicit recommendations; Phase 2 writes the YAML files after `mark_drafted`. A human invokes this in the Studio Authoring Builder tab, or any time they want to make protocol decisions incrementally rather than handing the agent a folder of materials.

---

## chart-review-calibrate (κ-based release gate)

**One-liner:** Computes per-criterion Cohen's κ from blind dual-reviewer samples; gates the draft → locked transition.

**Version:** 0.2.0

**Triggers on:**
- "calibrate this draft"
- "is this guideline ready to lock"
- "compute kappa for this protocol"
- "check inter-rater agreement"
- "validate the rubric"
- "run a calibration sample"

**Composes with:** `chart-review-improve` (acts on κ failures).

**References:**
- `kappa-thresholds.md` — Landis & Koch bucket definitions, κ formula with edge cases, minimum sample requirements, and metric selection by criterion type

**Health:** ✓ healthy. Cross-references to `skills/chart-review/references/reliability-metrics.md` and `lifecycle.md` resolve. Single-file references directory is intentional — most reliability content lives in the universal `reliability-metrics.md` and is cross-linked.

**Summary:** Pre-lock validation. Two or more reviewers blind-review the same patient sample; this skill computes per-criterion κ, surfaces disagreements with confusion matrices, writes a calibration report at `calibration/<guideline-id>/<run-id>/{report.md,raw.json}`, and recommends lock / improve-first / re-sample. A human invokes this once they've collected dual-reviewer data on a draft and need a defensible signal to lock.

---

## chart-review-cohort (drift / Role-C feedback)

**One-liner:** Walks a cohort of completed reviews under a locked guideline to detect drift and cluster overrides.

**Version:** 0.2.0

**Triggers on:**
- "what's drifting"
- "any patterns in recent overrides"
- "Role C analysis"
- "cohort feedback"
- "is the guideline still working"
- "agent quality over time"
- "run cohort QA"

**Composes with:** `chart-review-improve` (acts on the surfaced findings).

**References:** none (no `references/` subdirectory). The skill leans on `skills/chart-review/references/lifecycle.md` and `reliability-metrics.md` instead.

**Health:** ✓ healthy. No references/ directory but none promised in frontmatter; cross-references resolve.

**Summary:** Continuous-quality monitor for production. Computes per-criterion override rates over current vs baseline windows, flags drift exceeding the threshold (default 10 pp), clusters overrides by `edit_reason` and evidence pattern, writes `cohorts/<guideline-id>/feedback.{json,md}`. A human invokes this periodically (or after a corpus shift like a new EHR or new reviewer cohort) to ask "is the locked guideline still working?" — surfaces findings, never edits.

---

## chart-review-copilot (read-only reviewer Q&A)

**One-liner:** Read-only assistant for the human reviewer during validation — explain, retrieve, guide, document.

**Version:** 0.2.0

**Triggers on:**
- "summarize this patient"
- "why is this medium risk?"
- "show me the evidence for active disease"
- "why did the agent pick X?"
- "find evidence against this"
- "what does the guideline say about Y?"
- "help me write the override reason"
- "before I lock, anything I missed?"

**Composes with:** `chart-review` (which created the draft this copilot explains).

**References:** none (no `references/` subdirectory). Relies on `skills/chart-review/references/evidence-citation.md` and `mcp-tools.md`.

**Health:** ✓ healthy. No references/ directory; cross-references resolve.

**Summary:** Activated during human validation of an already-drafted patient review. Has no commit-path MCP tools — the structured review form is the only place answers go. A human reviewer invokes this with focused-field deictic questions (the review client prefixes messages with `[focused_field: ...]`) to interrogate the agent's reasoning, retrieve grouped evidence by strength, quote guideline rules verbatim, or draft override reasons. Calibrated, concise, cite-first, non-directive.

---

## chart-review-improve (proposal generator)

**One-liner:** Clusters disagreements into concrete proposed guideline edits — never writes the guideline directly.

**Version:** 0.2.0

**Triggers on:**
- "improve this guideline"
- "the agent keeps getting [criterion] wrong"
- "we keep overriding [field]"
- "tune the protocol"
- "fix the [criterion] guidance"
- "calibrate based on disagreements"

**Composes with:** `chart-review-calibrate` (consumes κ failures), `chart-review-cohort` (consumes drift signals).

**References:**
- `clustering-heuristics.md` — disagreement-table procedure, cluster signal types, change_kind selection mapping, edit_reason code definitions, minimum-patient thresholds
- `examples.md` — two worked examples (code-set trap; ambiguous-guidance cluster) with full proposal YAML
- `proposal-schema.md` — YAML schema for proposal files with per-`change_kind` shapes (edge_case_add, keyword_set_add, code_set_revise, guidance_prose_revise, gate_revise, derivation_revise, exemplar_add)

**Health:** ✓ healthy. Cross-reference to `skills/chart-review/references/lifecycle.md` resolves.

**Summary:** Reads override records under `reviews/<patient>/<guideline-id>/review_state.json`, builds a disagreement table, clusters by criterion + edit_reason + evidence pattern (≥3 motivating patients per cluster), and writes one proposal YAML per cluster to `proposals/<guideline-id>/<proposal-id>.yaml`. The methodologist accepts/rejects in the platform's proposal queue. A human invokes this after calibration or cohort feedback names specific failure modes.

---

## chart-review-methods (academic Methods drafter)

**One-liner:** Drafts a publication-grade Methods section from a locked guideline plus QA stats.

**Version:** 0.2.0

**Triggers on:**
- "write the methods section"
- "draft paper methods"
- "academic methods text"
- "methods paragraph for the manuscript"
- "describe the chart review for the paper"
- "STROBE methods" / "RECORD methods"

**Composes with:** `chart-review-calibrate` (provides calibration κ), the cohort + sample-validation workflow (provides deployment κ).

**References:**
- `journal-conventions.md` — voice/tense/specificity rules, what to omit, κ interpretation language, limitations conventions, word-count table
- `methods-template.md` — four-paragraph structure with sentence templates and per-paragraph fill-in guidance; STROBE/RECORD/CONSORT additions

**Health:** ✓ healthy. Cross-references to `skills/chart-review/references/reliability-metrics.md` and `lifecycle.md` resolve.

**Summary:** Past-tense, third-person, ~300–500-word Methods section. Four-paragraph default structure (protocol overview / criterion structure / reviewer process + reliability / limitations); extends to five paragraphs with a deployment-stage validation paragraph when a `deployment-kappa.json` is supplied. Verbatim criterion definition quotes; κ values come only from QA stats — never inferred. A human invokes this when preparing to publish a study based on a locked phenotype protocol.

---

## chart-review-lung-cancer-phenotype (rubric scope-skill)

**One-liner:** The portable lung-cancer-phenotype rubric — case definition, 11 criteria, code sets, keyword sets, edge cases, exemplars.

**Version:** N/A (this skill uses a different metadata shape — `guideline_id`, `case_definition`, `leaf_criteria_count`, `derived_criteria_count`, `state_anchor`)

**Triggers on:**
- "lung cancer"
- "lung cancer phenotype"
- "NSCLC"
- "SCLC"
- "pulmonary malignancy"
- "is this lung cancer"
- "lung cancer status"
- "lung cancer review"

**Composes with:** `chart-review` (the universal methodology that consumes this rubric).

**Rubric structure** (audit of `references/`):
- `case-definition.md` — top-level label semantics, lookback window, source-document priority
- `criteria/` — 11 files (7 leaf + 4 derived). All carry frontmatter with `field_id`, `answer_schema`, and `schema_hash`. Verified files: `clinical_diagnosis_lung_cancer.md`, `cytology_supports_lung_primary.md`, `icd_lung_cancer_present.md`, `imaging_lung_lesion.md`, `lowest_hemoglobin_in_window.md`, `lung_cancer_status.md`, `oncologist_lung_cancer_diagnosis_in_note.md`, `pathology_confirms_lung_cancer.md`, `pathology_lung_primary.md`, `pathology_report_present.md`, `pre_treatment_anemia_present.md`
- `code_sets/` — 1 file (`lung_cancer_icd10.md`)
- `keyword_sets/` — 3 files (`imaging_findings.md`, `lung_anatomy.md`, `pathology_terms.md`)
- `edge_cases/` — 3 files (`carcinoid_classified_as_other_lung.md`, `imaging_alone_without_pathology.md`, `z85_118_personal_history_excluded.md`)
- `exemplars/` — 1 file (`pt_017_history_only.md`)

**Health:** ✓ healthy. Frontmatter declares `leaf_criteria_count: 7` + `derived_criteria_count: 4` = 11 — matches the actual file count. Every criterion file has the required `field_id`, `answer_schema`, and `schema_hash`. Every code set / keyword set / edge case / exemplar referenced from SKILL.md exists on disk. Note: this skill intentionally does *not* carry a `version` field — it uses a phenotype-rubric metadata shape (`guideline_id` + counts + `state_anchor`) tied to the runtime state at `guidelines/lung-cancer-phenotype/maturity.json`.

**Summary:** A rubric scope-skill — domain data, not procedure. Loads automatically when a user names lung cancer in a chart-review context. Provides the case-definition vocabulary, criteria, code sets, keyword sets, edge cases, and exemplars that the universal `chart-review` skill consumes. Runtime lifecycle state (phase, pilots, lock-test results, version snapshots) lives at `guidelines/lung-cancer-phenotype/`, separate from this portable rubric definition.

---

## Audit summary

**Audited:** 9 skills.

**Healthy:** 9 / 9.

**Issues:** none. All frontmatter is valid (where applicable — the lung-cancer phenotype skill intentionally uses a different metadata shape since it's a rubric carrier rather than a procedure skill). Every cross-reference of the form `skills/chart-review/references/<file>.md` resolves to a real file. No actual TODO/FIXME markers in the skill text — every "TODO" mention is intentional documentation of the TODO pattern (e.g., "leave a `# TODO: confirm codes` comment when codes are unknown"). The lung-cancer phenotype rubric is structurally sound: 11 criteria files, all with required frontmatter (`field_id`, `answer_schema`, `schema_hash`); every code set / keyword set / edge case / exemplar named in SKILL.md exists on disk.

### Compose-with DAG

```
                    ┌───────────────────────────────────────────┐
                    │                                           │
                    │   chart-review-lung-cancer-phenotype      │
                    │   (rubric scope-skill — domain data)      │
                    │                                           │
                    └────────────────────┬──────────────────────┘
                                         │ provides rubric to
                                         ▼
                    ┌───────────────────────────────────────────┐
                    │                                           │
                    │             chart-review                  │
                    │      (universal reviewer methodology)     │
                    │                                           │
                    └────────────────────┬──────────────────────┘
                                         │ produces draft
                                         ▼
                    ┌───────────────────────────────────────────┐
                    │           chart-review-copilot            │
                    │     (read-only Q&A during validation)     │
                    └───────────────────────────────────────────┘


  AUTHORING                CALIBRATION              IMPROVEMENT             PUBLICATION
  ─────────                ───────────              ───────────             ───────────

  chart-review-author ◄──────────────┐
       ▲                             │
       │ subsumed by                 │ feeds draft to
       ▼                             ▼
  chart-review-build  ───────►  chart-review-calibrate  ─────►  chart-review-improve
                                     ▲                                  ▲
                                     │                                  │
                                     │ provides κ                       │ provides drift signals
                                     │                                  │
                                     │                          chart-review-cohort
                                     │                                  │
                                     │ provides calibration-κ           │
                                     ▼                                  ▼
                                                       chart-review-methods
                                                  (academic Methods section)
```

Edge legend:
- `chart-review-build` *subsumes* `chart-review-author` for interactive use; both write to `guidelines/drafts/<task-id>/`.
- `chart-review-calibrate` is the **release gate** between draft and locked.
- `chart-review-improve` consumes input from both `chart-review-calibrate` (κ failures) and `chart-review-cohort` (drift signals); never writes the guideline directly — emits proposals.
- `chart-review-cohort` consumes only locked guidelines; surfaces findings, never proposes edits.
- `chart-review-methods` requires a locked guideline plus QA stats (calibration κ at minimum, deployment κ optionally).
- `chart-review-copilot` runs at validation time only; never commits answers.
- The phenotype scope-skill (`chart-review-lung-cancer-phenotype`) auto-activates on phenotype mention and feeds the rubric to `chart-review`. New phenotypes follow the same `chart-review-<noun>-phenotype` naming convention.
