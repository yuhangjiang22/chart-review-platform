---
field_id: stroke_history
prompt: Does the patient have a documented history of stroke (any type)?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: lookback_lifetime
---

## Definition

The HAS-BLED S component scores 1 point for any prior stroke. Unlike
CHA₂DS₂-VASc (which only counts ischemic strokes / TIA / embolism),
HAS-BLED counts ALL stroke types — including hemorrhagic — because the
relevant risk being scored is bleeding propensity, not embolic risk.

## Extraction guidance

- Problem list / ICD-10: I60.x (SAH), I61.x (intracerebral hemorrhage),
  I63.x (cerebral infarction), G45.x (TIA — not counted by HAS-BLED but
  documented as ambiguous)
- Imaging reports of acute or chronic stroke
- Provider notes "h/o CVA", "prior stroke"

## Examples

**Satisfying ("yes"):**
- "PMH: ischemic stroke 2020" → yes
- "h/o intracerebral hemorrhage 2018" → yes (HAS-BLED counts hemorrhagic)
- "Brain MRI: chronic infarcts" → yes

**Non-satisfying ("no"):**
- "Migraine with aura" → no
- "TIA 2019" — borderline; HAS-BLED's original definition was "stroke,"
  not "stroke or TIA." Strict reading → "no". Document the borderline.

## Boundary / failure modes

- Subdural / epidural hematoma alone → "no" (not technically a stroke)
- Cerebral venous sinus thrombosis → "yes" (counted as stroke for
  bleeding-risk purposes)
- Family history of stroke → "no"
