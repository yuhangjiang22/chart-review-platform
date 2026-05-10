---
field_id: stroke_or_tia_history
prompt: Does the patient have a documented history of ischemic stroke, TIA, or thromboembolism?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: lookback_lifetime
---

## Definition

Any prior ischemic stroke, transient ischemic attack (TIA), or systemic
thromboembolism documented in the chart. The CHA₂DS₂-VASc "S₂" component
weighs this at 2 points because prior cerebrovascular events are the
strongest single predictor of recurrence in AFib.

## Extraction guidance

- Problem list / encounter ICD-10:
  - I63.x — cerebral infarction (ischemic stroke)
  - G45.x — TIA and related syndromes
  - I74.x — arterial embolism / thrombosis
- Imaging reports of acute or chronic ischemic infarct
- Provider notes: "h/o CVA", "prior stroke", "history of TIA", "post-stroke deficits"
- Hemorrhagic stroke alone (I60–I62) does NOT qualify for the S₂ component
  in the original CHA₂DS₂-VASc definition (it is treated separately in
  HAS-BLED for bleed risk)

## Examples

**Satisfying:**
- "PMH: ischemic stroke 2018 with mild residual right hemiparesis"
- "Brain MRI 2022: chronic infarcts in the left MCA territory"
- ICD-10 G45.9 (TIA, unspecified) on a prior encounter

**Non-satisfying:**
- "Hemorrhagic stroke 2019" (only the ischemic / TIA / embolism types count)
- "Migraine with aura" — distinct from TIA, not counted
- Family history of stroke

## Boundary / failure modes

- Mixed stroke (initial hemorrhagic conversion of an infarct) → "yes" (an
  ischemic event occurred)
- "Cryptogenic stroke" → "yes"
- Subdural / epidural hematoma → "no"
- Documented TIA later "ruled out" by neurology → "no"
