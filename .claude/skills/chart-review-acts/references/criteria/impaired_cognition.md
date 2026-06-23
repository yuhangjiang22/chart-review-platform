---
field_id: impaired_cognition
prompt: Does the note document impaired cognition (MCI, dementia, or another neurocognitive disorder) for this patient?
answer_schema:
  enum:
    - "1"
    - "0"
cardinality: one
group: cognition
---

# Criterion: impaired_cognition

## Definition

Whether the chart documents **impaired cognition** for THIS patient — a decline
in memory, executive function, attention, language, visuospatial skills, or
reasoning greater than expected for normal aging (NIA-AA core clinical criteria).
Both **Mild Cognitive Impairment (MCI)** and **dementia / major neurocognitive
disorder** count as impaired cognition.

Two answers only: **`1`** (impaired cognition present) or **`0`** (no evidence of
impairment / cognition documented normal / not addressed). Use only what is
documented about the patient — do not infer.

## Extraction guidance

Assign **`1`** if ANY of the following are documented for the patient:
- **Explicit diagnosis:** MCI, amnestic MCI, mild/major neurocognitive disorder,
  dementia, Alzheimer's disease/dementia, vascular dementia, Lewy body dementia,
  frontotemporal dementia, mixed dementia.
- **Cognitive decline corroborated by objective evidence or clinician
  determination:** documented memory impairment / cognitive decline / cognitive
  deficits assessed by a clinician, or paired with abnormal testing/exam.
- **Objective testing interpreted as impaired:** abnormal MMSE/MoCA,
  neuropsychological evaluation documenting deficits, "MoCA consistent with MCI".
- **Clinician assessment of cognitive dysfunction:** executive dysfunction,
  cognitive disorder, impaired memory affecting function.

Assign **`0`** if cognition is documented normal ("cognitively intact", "no
cognitive impairment", "MoCA within normal limits") or there is no evidence of
impairment.

**Do NOT count as positive** (→ `0`):
- **Family history** ("mother had Alzheimer's", "family history of dementia") —
  describes relatives, not the patient.
- **Evaluation/workup only** ("referred for memory evaluation", "dementia workup
  planned", "neuropsych testing ordered") — does not confirm impairment.
- **Subjective concern without corroboration** ("concern for memory problems",
  "possible cognitive decline", "rule out dementia", informant-reported decline
  with no objective/clinician confirmation).
- **Delirium / transient confusion** (acute encephalopathy, delirium,
  postoperative or infection-related altered mental status) unless the clinician
  explicitly diagnoses MCI/dementia/cognitive impairment.

Priority when conflicting: explicit diagnosis > general statements; specialist >
screening language; current > remote; confirmed > suspected.

**Evidence:** cite the SMALLEST affirmative span that justifies the answer (the
diagnosis line, the impaired testing interpretation, or the clinician statement).
For `0`, cite the short "cognition normal" span or the assessment section you
checked. Never cite a negated/family-history sentence to support `1`.

## Examples

- "Diagnosed with Alzheimer's disease." → `1`
- "Patient has mild cognitive impairment." → `1`
- "MoCA consistent with mild cognitive impairment." → `1`
- "Family reports decline; clinician documents impaired performance on exam." → `1`
- "Patient remains cognitively intact." → `0`
- "MoCA within normal limits." → `0`
- "Mother had Alzheimer's disease." → `0` (family history)
- "Referred for memory evaluation." → `0` (evaluation only)
- "Rule out dementia." / "Possible cognitive decline." → `0` (subjective/suspected)
- "Delirium from UTI; no prior cognitive diagnosis." → `0` (transient)
