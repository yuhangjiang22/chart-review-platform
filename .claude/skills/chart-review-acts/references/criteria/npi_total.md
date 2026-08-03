---
field_id: npi_total
prompt: What is the documented Neuropsychiatric Inventory (NPI) total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 144
cardinality: one
group: neuropsych_scales
---

# Criterion: npi_total

## Definition

The documented **Neuropsychiatric Inventory (NPI) total score** for THIS patient
— a structured measure of behavioral and psychological symptoms (e.g.,
delusions, agitation, depression, apathy, disinhibition), where a higher score
means greater neuropsychiatric burden. The maximum depends on the version:
**NPI-10** ranges **0–120**, the **NPI-12** ranges **0–144**, and the brief
**NPI-Q** severity total ranges **0–36**. This field records the raw total
symptom score; the separate caregiver/informant-distress score is NOT part of
this total.

## Extraction guidance

Record the **RAW number documented** and cite the exact note span. Do **NOT**
infer the score from a severity word ("significant behavioral symptoms", "marked
agitation") — capture only an explicit numeric total. If **NO number is
documented**, leave the answer **null** (do **NOT** write `0`). Exclude family
history, planned/ordered ("NPI to be completed"), and negated mentions ("NPI not
administered").

Record the version (NPI-10 / NPI-12 / NPI-Q) in the rationale when the chart
states it, so the maximum is unambiguous. Do **NOT** merge in or add the separate
caregiver-distress score — capture the symptom total only.

## Examples

- "NPI-12 total score 48." → `48`
- "Neuropsychiatric Inventory: 30 (severity), caregiver distress 12." → `30`
- "NPI-Q severity 9." → `9`
- "Patient has significant behavioral disturbance." → (leave unanswered, not 0)
- "not documented" → (leave unanswered, not 0)

**Evidence:** cite the score span.
