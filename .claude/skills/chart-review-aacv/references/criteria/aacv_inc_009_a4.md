---
field_id: aacv_inc_009_a4
prompt: Is the cognitive decline reported by the participant themselves?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: cognition
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [informant_collateral, cognitive_decline]
---

# Criterion: Decline reported by the participant

## Definition

AACV inclusion criterion [9], protocol p.40, in full: *"Have gradual and progressive
cognitive decline, as reported by the participant or by the study partner or
other informant, for ≥6 months from the time of signing the informed consent."*

This atom is the first reporter branch. The criterion accepts the report from any one of three sources — participant, study partner, or other informant. One satisfied reporter atom is enough; an unmet one disqualifies no one.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `TEMPORAL_DIRECTION_WORDING_AMBIGUOUS` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `condition_met` — the chart documents the participant's own complaint:
  "patient reports memory getting worse", a subjective memory complaint in the
  HPI attributed to the patient
- `condition_not_met` — the chart affirmatively documents that the participant
  denies or is unaware of decline (common in dementia — record it; it
  disqualifies no one, since one satisfied sibling branch suffices)
- `unknown` — attribution of the history is unclear

State in `rationale` who the note attributes the history to. Terms: patient
reports, c/o memory loss, subjective memory complaint, per patient, denies
memory problems.

## Examples

- "Patient reports worsening memory over the past year" → `condition_met`
- "Patient denies memory problems; daughter disagrees" → `condition_not_met`
  here, and the daughter's account satisfies `aacv_inc_009_a6`
- History section with no attribution → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
