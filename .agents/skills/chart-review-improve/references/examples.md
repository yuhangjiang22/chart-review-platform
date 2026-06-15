# Examples — chart-review-improve

Worked examples of the clustering → proposal workflow.

## Example 1: clustering a recurring code-set trap

**Disagreements observed on `icd_lung_cancer_present`:**

```
patient_a: agent=true, reviewer=false, edit_reason=wrong_rule,
           reviewer cited "only Z85.118"
patient_b: agent=true, reviewer=false, edit_reason=wrong_rule,
           reviewer cited "only Z85.118 in lookback"
patient_c: agent=true, reviewer=false, edit_reason=wrong_rule,
           reviewer cited "Z85.118; no active C34"
```

**Cluster:** 3 patients, same criterion, same edit_reason, same evidence pattern.

**Root cause:** Z85.118 is a personal history code; the agent counted it as
active disease. The code set's `excludes:` list doesn't include it.

**Proposal:**

```yaml
id: prop-7f3a
guideline_id: lung-cancer-phenotype
target_field: icd_lung_cancer_present
change_kind: code_set_revise
motivating_patients: [patient_a, patient_b, patient_c]
evidence:
  - patient: patient_a
    agent_answer: true
    reviewer_answer: false
    edit_reason: wrong_rule
    reviewer_evidence: "only Z85.118"
proposal:
  code_set:
    id: lung_cancer_icd10
    field: excludes
    add:
      - code: Z85.118
        reason: Personal history — not active disease.
rationale: Three reviewers overrode the agent because Z85.118 is a
  history-only code; agent counted it as active disease. Adding the
  explicit exclude prevents the trap.
provenance:
  source: override_pattern
  status: draft
```

## Example 2: ambiguous guidance triggering inconsistent overrides

**Disagreements on `pathology_lung_primary`:**

```
patient_d: agent=nsclc, reviewer=other_lung, edit_reason=misinterpreted,
           reviewer cited "carcinoid"
patient_e: agent=nsclc, reviewer=other_lung, edit_reason=misinterpreted,
           reviewer cited "atypical carcinoid"
patient_f: agent=nsclc, reviewer=other_lung, edit_reason=misinterpreted,
           reviewer cited "large-cell neuroendocrine"
```

**Cluster:** 3 patients, carcinoid / neuroendocrine tumors mis-classified.
The guidance prose doesn't address these histologies.

**Root cause:** agent conflates "non-small-cell" (a histologic descriptor)
with "NSCLC" (a specific category that excludes carcinoids).

**Proposal:**

```yaml
id: prop-2c4b
guideline_id: lung-cancer-phenotype
target_field: pathology_lung_primary
change_kind: edge_case_add
motivating_patients: [patient_d, patient_e, patient_f]
evidence:
  - patient: patient_d
    agent_answer: nsclc
    reviewer_answer: other_lung
    edit_reason: misinterpreted
    reviewer_evidence: "carcinoid"
proposal:
  edge_case:
    id: carcinoid_classified_as_other_lung
    pattern: |
      Pathology identifies a typical or atypical carcinoid (neuroendocrine
      tumor) of the lung. Carcinoids are NOT non-small-cell carcinomas.
    applies_to: [pathology_lung_primary]
    failure_mode: Defaulting to nsclc for any non-small-cell histology.
    correct_answer_hint: pathology_lung_primary should be `other_lung`.
rationale: Three reviewers overrode the agent on carcinoid / neuroendocrine
  cases. The agent was conflating "non-small-cell" with "NSCLC". Adding the
  explicit edge case prevents the mis-classification.
provenance:
  source: override_pattern
  status: draft
```
