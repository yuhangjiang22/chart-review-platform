---
field_id: eye_exam_by_eye_care_pro
prompt: Was the eye exam performed by an eye care professional (ophthalmologist or optometrist)?
answer_schema:
  type: enum
  enum: ["yes", "no", "not_applicable"]
is_final_output: false
is_applicable_when: 'eye_exam_in_window == "yes"'
---

## Definition

ADA requires the screening exam be performed by an
"ophthalmologist or optometrist who has knowledge and experience in
diagnosing the presence of diabetic retinopathy." Primary-care
clinician fundoscopy alone does NOT qualify, even if dilated.

Gated on `eye_exam_in_window == "yes"`.

## Extraction guidance

- Provider specialty in the encounter record: "Ophthalmology",
  "Optometry", "Ophthalmology — Retina", "Ophthalmology Fellow"
- NPI taxonomy lookup: 207W00000X (Ophthalmology), 152W00000X
  (Optometry), 207WX0107X (Ophthalmology, Retina)
- Letters or referrals from external eye-care providers: counted as
  yes if the provider's specialty is documented.
- Tele-retinal screening: counts as yes if the *interpreting*
  ophthalmologist/optometrist is documented (the technician taking
  photos doesn't need to be an eye-care-pro).

## Examples

**Satisfying ("yes"):**
- Encounter at "Ophthalmology — Retinal Specialty" clinic
- "Optometrist's note from Dr. Smith, OD, attached"
- "Tele-retinal screening images interpreted by Dr. Lee, MD,
  Ophthalmology"

**Non-satisfying ("no"):**
- PCP performed bedside fundoscopy; no ophthalmology referral
- "Eye exam by RN as part of annual physical"

**Not applicable:**
- No eye exam in window (gated)

## Boundary / failure modes

- Endocrinologist performs fundoscopy → "no" (endocrinology is not in
  the recognized ADA list for screening interpretation).
- Optician (refraction-only specialist) performed exam → "no"
  (opticians are not optometrists; they don't diagnose retinopathy).
- Resident-physician ophthalmology clinic with attending sign-off →
  "yes" (attending is the responsible provider).
