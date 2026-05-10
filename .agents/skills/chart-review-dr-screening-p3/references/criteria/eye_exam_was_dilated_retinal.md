---
field_id: eye_exam_was_dilated_retinal
prompt: Was the eye exam in the past 12 months a dilated retinal exam?
answer_schema:
  type: enum
  enum: ["yes", "no", "not_applicable"]
is_final_output: false
is_applicable_when: 'eye_exam_in_window == "yes"'
time_window_check: skip  # gated by eye_exam_in_window — that leaf owns the 12-month window
---

## Definition

For patients with at least one eye exam in the lookback window, this
criterion asks whether the exam was a *dilated retinal* exam — the
ADA-recommended modality. Visual-acuity-only encounters, eye-pressure
checks, or non-dilated fundus screens do NOT qualify.

Gated on `eye_exam_in_window == "yes"` — patients with no exam at all
return `not_applicable` here.

## Extraction guidance

- Procedure codes for dilated fundus exam: 92002 / 92012 (intermediate
  ophthalmologic services with fundus exam), 92004 / 92014
  (comprehensive), 92250 (fundus photography), 92227 / 92228
  (telescreening with retinal imaging — counts per ADA 2024 update).
- Note text: "fundus exam," "retinal exam," "dilated funduscopy,"
  "FundoScan," "retinal photographs."
- Pupillary dilation drops administered (tropicamide, phenylephrine)
  documented in encounter notes.
- Optical coherence tomography (OCT) alone, without dilated fundus
  exam, does NOT qualify for the ADA recommendation.

## Examples

**Satisfying ("yes"):**
- "Dilated fundus exam: bilateral mild NPDR"
- "Retinal photographs taken; reviewed by ophthalmologist"
- "Tele-retinal screening, no DR"

**Non-satisfying ("no"):**
- "Visual acuity check only — 20/30 OD, 20/30 OS"
- "Eye pressure 14 mmHg bilaterally"
- "OCT only, no fundus exam documented"

**Not applicable:**
- No eye exam in window (gated)

## Boundary / failure modes

- Patient with prior cataracts who can't be dilated → may have had
  fundus photography instead; that counts.
- Refraction encounter only → "no" (not a retinal exam)
- "Funduscopic exam" without dilation in the note → "no" unless
  dilation drops are documented.
