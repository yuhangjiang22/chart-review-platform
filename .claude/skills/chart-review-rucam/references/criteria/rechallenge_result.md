---
field_id: rechallenge_result
prompt: For Item 7, what was the result of re-administration (rechallenge) of the suspect drug?
answer_schema:
  enum: [positive_alone, positive_with_codrug, below_uln, none_or_insufficient]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: rechallenge_result

## Definition

The result of re-exposure to the suspect drug (valid rechallenge requires ≥45 days
between T0 and re-exposure):
- `positive_alone` — anchor lab doubled on re-exposure, suspect drug alone.
- `positive_with_codrug` — anchor lab doubled, but a co-drug was also present.
- `below_uln` — an increase occurred but stayed below the upper limit of normal.
- `none_or_insufficient` — no re-exposure, gap <45 days, or lab data insufficient.

## Extraction guidance

Check `get_patient_summary` `rechallenge_flag` AND notes ("rechallenge", "re-exposure",
"restarted", "resumed", "inadvertent", "took again"). Verify the ≥45-day gap. Anchor
lab: ALT for hepatocellular, ALP/bilirubin for cholestatic/mixed.
