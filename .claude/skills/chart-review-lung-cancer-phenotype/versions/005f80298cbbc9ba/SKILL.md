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
case definition (what counts as confirmed / probable / absent), the
lookback window, and the source-document priority order.

## Criteria

This rubric has 7 leaf criteria + 4 derived criteria. Each criterion is a
separate file under `references/criteria/`; the chart-review skill discovers
them by directory listing.

### Leaf criteria (require direct evidence extraction)
- `pathology_report_present` — is a qualifying pathology report in the window?
- `pathology_lung_primary` — histology type from the pathology report
- `cytology_supports_lung_primary` — cytology support when no surgical specimen exists
- `imaging_lung_lesion` — imaging shows suspicious lung mass/nodule/lesion
- `oncologist_lung_cancer_diagnosis_in_note` — oncologist/pulmonologist documents diagnosis
- `icd_lung_cancer_present` — active C34.* ICD-10 code on encounter or problem list
- `lowest_hemoglobin_in_window` — numeric; feeds the anemia derived field

### Derived criteria (computed from leaf values — no direct evidence required)
- `pathology_confirms_lung_cancer` — true iff pathology present AND lung primary identified
- `clinical_diagnosis_lung_cancer` — true iff imaging AND oncologist note both positive
- `pre_treatment_anemia_present` — true iff Hgb < 12 g/dL in window
- `lung_cancer_status` — final three-tier label (confirmed / probable / absent)

## Code sets
- `references/code_sets/lung_cancer_icd10.md` — C34.* family; explicit Z85.118 exclusion

## Keyword sets (used by criteria at runtime)
- `references/keyword_sets/imaging_findings.md` — radiologic descriptors
- `references/keyword_sets/lung_anatomy.md` — anatomical terms
- `references/keyword_sets/pathology_terms.md` — pathology and cytology vocabulary

## Edge cases
- `references/edge_cases/z85_118_personal_history_excluded.md`
- `references/edge_cases/carcinoid_classified_as_other_lung.md`
- `references/edge_cases/imaging_alone_without_pathology.md`

## Exemplars
- `references/exemplars/pt_017_history_only.md` — Z85.118 personal history; answer is absent

## How to use this rubric

When the chart-review skill is active and this skill is loaded:
1. Read `references/case-definition.md` for label semantics and review window
2. For each leaf criterion in `references/criteria/`, read the file and apply
   the extraction rules to the active patient's chart
3. For derived criteria, apply the derivation expression from the file's
   frontmatter rather than searching for evidence
4. Before a criterion with `uses.edge_cases`, check the referenced edge case
   file for known failure modes
5. Cite evidence per `.claude/skills/chart-review/references/evidence-citation.md`
   (required for every `set_field_assessment` call on a leaf criterion)
6. Commit answers via `set_field_assessment` (chart_review_state MCP)

## Lifecycle metadata

This skill is the **portable rubric**. Platform-runtime state for this
deployment lives at `guidelines/lung-cancer-phenotype/`:
- `maturity.json` — current phase (draft / piloted / calibrated / locked / deployed)
- `pilots/iter_NNN/` — per-iteration run history
- `sampling.json` — cohort assignment for pilots
- `lock_test/` — lock eligibility test results
- `versions/` — historical snapshots of the rubric YAML
