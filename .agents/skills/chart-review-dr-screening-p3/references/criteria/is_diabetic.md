---
field_id: is_diabetic
prompt: At the index date, does the patient have active diabetes mellitus (T1 or T2)?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window_check: skip  # point-in-time evaluation; "history of" appears only in exclusion guidance
---

## Definition

Active diabetes mellitus at the index date — type 1 or type 2 — based
on the problem list, active medications, or recent labs. Patients
documented "in remission" or with isolated history of gestational
diabetes are NOT counted.

Point-in-time evaluation — no time_window in frontmatter.

## Extraction guidance

- Problem list: ICD-10 E10.x (T1) or E11.x (T2)
- Active medications: insulin, metformin, GLP-1 agonist, SGLT-2,
  sulfonylurea, etc., with DM indication
- Recent HbA1c ≥ 6.5% with documented DM diagnosis
- Provider notes "DM2 well-controlled on metformin"

## Examples

**Satisfying ("yes"):**
- "PMH: T2DM on metformin"
- "Active problems: diabetes mellitus type 1"

**Non-satisfying ("no"):**
- "T2DM in remission post-bariatric, off all DM meds, A1c 5.4%"
- "Hx of gestational diabetes 5 years ago, no current DM"
- "Pre-diabetes" alone

## Boundary / failure modes

- Type 2 in remission: deliberately excluded from this rubric per the
  build-time decision (P3 turn 16). ADA actually recommends ongoing
  screening for these patients — calibration may surface this as a gap.
- Steroid-induced hyperglycemia without DM diagnosis → "no"
- Patient coded for DM only at one historical encounter, not on the
  current problem list → "no"
