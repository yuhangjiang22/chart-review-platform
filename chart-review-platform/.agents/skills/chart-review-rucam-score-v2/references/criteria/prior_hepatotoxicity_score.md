---
field_id: prior_hepatotoxicity_score
prompt: What RUCAM "prior knowledge of drug hepatotoxicity" score applies to this drug?
answer_schema:
  type: integer
  minimum: 0
  maximum: 2
is_final_output: false
time_window_check: skip  # "prior" describes drug pharmacovigilance class — no patient-relative window applies
---

## Definition

RUCAM's component 6 scores how well-established the drug's hepatotoxicity is:

| Prior information | Score |
|---|---|
| Drug listed in product label / monograph as hepatotoxic | +2 |
| Hepatotoxicity reported in published case reports / pharmacovigilance database but not in product label | +1 |
| No published reports of hepatotoxicity for this drug | 0 |

Use LiverTox (livertox.nih.gov) or the local product label as the
authoritative source.

## Extraction guidance

- Identify the suspect drug (the index drug for this RUCAM).
- Look up LiverTox category:
  - Category A or B (well-established or likely) → +2
  - Category C, D, or E* (limited or uncertain) → +1
  - Category X or no listing → 0
- If the chart cites the product label or LiverTox directly, use that
  citation.

## Examples

- Suspect drug is isoniazid → LiverTox Category A → +2
- Suspect drug is fingolimod (MS DMT) → LiverTox Category C → +1
- Suspect drug is a novel agent with no published hepatotoxicity reports → 0

## Boundary / failure modes

- If multiple suspect drugs are at play, this rubric applies the score to the
  index drug only; concomitant-drug scoring (RUCAM component 4) is deferred
  to v1.
- "Hepatotoxicity in animal studies only" → 0.
