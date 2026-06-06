---
id: imaging_findings
description: Radiologic descriptors that may indicate a lung lesion.
version: "2026-04-30"
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
  GGO:
    - ground-glass opacity
    - ground glass opacity
  spiculated:
    - spiculation
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: "2026-04-30"
  status: approved
---

# Keyword Set: imaging_findings

Radiologic terms used when searching imaging reports for evidence relevant to
`imaging_lung_lesion`. The presence of one or more of these terms in a CT chest,
PET-CT, or chest X-ray report is a signal to read the report carefully and apply
the criterion definition.

## Terms

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

## Synonyms

| Term | Accepted synonyms |
|---|---|
| GGO | ground-glass opacity, ground glass opacity |
| spiculated | spiculation |

## Usage notes

Finding one of these terms in an imaging report does not automatically satisfy
`imaging_lung_lesion`. The criterion requires the radiologist to describe the
finding as suspicious for malignancy. Stable benign-appearing nodules (e.g.,
"stable 4 mm nodule, likely granuloma") do not satisfy the criterion even if
the term "nodule" appears.
