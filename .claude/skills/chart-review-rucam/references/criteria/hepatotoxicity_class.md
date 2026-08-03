---
field_id: hepatotoxicity_class
prompt: For Item 6, what is the suspect drug's known-hepatotoxicity class from the LiverTox masterlist?
answer_schema:
  enum: [labeled, probable, none]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: hepatotoxicity_class

## Definition

The suspect drug's prior-hepatotoxicity knowledge, from `get_hepatotoxicity_category`
(LiverTox masterlist — authoritative, never model memory):
- `labeled` — LiverTox category **A** (well-known, FDA-labeled hepatotoxin).
- `probable` — category **B** (published case reports, not on label).
- `none` — category C/D/E/E* or drug not listed (no convincing evidence).

## Extraction guidance

Call `get_hepatotoxicity_category(<suspect drug>)` and map the returned `category`
to `labeled` (A) / `probable` (B) / `none` (else). Notes only upgrade if a clinician
explicitly documents the drug's known hepatotoxicity for this patient.
