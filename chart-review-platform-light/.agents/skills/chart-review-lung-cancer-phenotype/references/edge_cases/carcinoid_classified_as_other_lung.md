---
id: carcinoid_classified_as_other_lung
pattern: |
  Pathology identifies a typical or atypical carcinoid (neuroendocrine tumor) of
  the lung. Carcinoids are NOT non-small-cell carcinomas in the conventional sense.
applies_to:
  - pathology_lung_primary
failure_mode: Defaulting to `nsclc` for any non-small-cell histology.
correct_answer_hint: 'pathology_lung_primary should be `other_lung`.'
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: "2026-04-30"
  status: approved
---

# Edge Case: carcinoid_classified_as_other_lung

## Pattern

A pathology report identifies a typical or atypical carcinoid (neuroendocrine
tumor) of the lung. The report confirms a lung primary, but the histologic
type is a carcinoid — not a non-small-cell carcinoma in the conventional
sense (i.e., not adenocarcinoma, squamous cell carcinoma, or large-cell
carcinoma).

This edge case arises because reviewers may default to `nsclc` for any
lung-primary tumor that is not explicitly labeled "small cell." Carcinoids
are sometimes grouped loosely with "non-small-cell" tumors in clinical
conversation, but for this rubric they are a distinct histology.

## Correct answer

`pathology_lung_primary` should be `other_lung`.

The WHO classification used by this rubric maps histologic types as follows:
- Adenocarcinoma, squamous cell carcinoma, large-cell carcinoma → `nsclc`
- Small cell carcinoma → `sclc`
- Carcinoid (typical or atypical), large-cell neuroendocrine carcinoma,
  and other neuroendocrine tumors → `other_lung`
- Mesothelioma, metastatic disease from a non-lung primary → `non_lung`

A carcinoid of the lung is still a lung primary malignancy and will still
drive `pathology_confirms_lung_cancer` to `true` (since `other_lung` is
among the qualifying values). The distinction matters for downstream
histology-stratified analyses.
