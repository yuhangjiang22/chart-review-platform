---
field_id: psychiatry_referral
prompt: Is a psychiatry/mental-health referral or contact documented, post-index?
answer_schema:
  enum:
    - "yes"
    - "no"
    - no_info
cardinality: one
group: study1_evidence
---

# Criterion: psychiatry_referral

## Definition

Whether the chart documents a psychiatry consult, mental health referral,
counselor, psychotherapist, or behavioral health contact, in a note dated
strictly after the index date.

## Extraction guidance

- **`yes`** — an explicit referral, consult, or ongoing contact: "psychiatry
  consult placed", "referred to mental health", "sees counselor/therapist",
  "behavioral health follow-up", "CBT", "psychotherapist".
- **`no`** — the note affirmatively documents no referral/contact, or
  explicitly declines one ("patient declined psychiatry referral").
- **`no_info`** — not addressed anywhere in the notes.

### Do NOT count as positive evidence
- A **generic** mention of "behavioral health" as a department name in
  boilerplate/letterhead with no patient-specific referral action.
- Excluded sections: Discharge Instructions boilerplate, patient instruction
  templates.

## Confidence
- `high` = explicit referral order or documented ongoing psychiatric/
  counseling care.
- `medium` = indirect mention (e.g. "possible mental health referral"
  without confirmation it was placed).
- `low` = ambiguous — prefer `no_info` over a low-confidence `yes`.

## Examples

- "Referral placed to psychiatry for medication management" → `yes` (high)
- "Follows with outpatient therapist weekly" → `yes` (high)
- "Possible Mental Health Referral" (noted but not confirmed placed) → `yes` (medium)
- "Patient declined counseling referral" → `no`
- Not mentioned anywhere → `no_info`

## Evidence rule
If referral/contact is documented in more than one note (e.g. an initial
referral and a later follow-up visit note), **cite each as its own evidence
item**. Cite the affirmative span naming the referral/contact. For `no`,
cite the decline/negation statement. For `no_info`, cite the section you
checked (e.g. Assessment/Plan) where a referral would appear if present.
