---
id: pathology_terms
description: Vocabulary for pathology and cytology specimens.
version: "2026-04-30"
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
  FNA:
    - fine needle aspiration
  IHC:
    - immunohistochemistry
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: "2026-04-30"
  status: approved
---

# Keyword Set: pathology_terms

Pathology and cytology vocabulary for identifying relevant specimen documents.
Used by `pathology_lung_primary` when scanning the chart for qualifying
pathology reports.

## Terms

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

## Synonyms

| Abbreviation | Full form |
|---|---|
| FNA | fine needle aspiration |
| IHC | immunohistochemistry |

## Usage notes

Documents tagged with a pathology LOINC code (e.g., 11526-1 for surgical
pathology) are the highest-priority source. When no tagged document is
available, use these terms to identify untagged text notes that may contain
pathology content.

Note the distinction between biopsy/surgical pathology (which can satisfy
`pathology_report_present`) and cytology-only specimens (which cannot satisfy
`pathology_report_present` but may satisfy `cytology_supports_lung_primary`).
Terms like "FNA", "fine needle aspiration", "pleural fluid cytology", and
"bronchial brushing" are cytology-associated and should trigger careful
review of whether the specimen produced a histologic diagnosis or cytologic
interpretation only.
