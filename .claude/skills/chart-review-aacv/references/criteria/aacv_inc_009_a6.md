---
field_id: aacv_inc_009_a6
prompt: Is the cognitive decline reported by an informant other than the participant?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: cognition
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [informant_collateral, cognitive_decline]
---

# Criterion: Decline reported by another informant

## Definition

AACV inclusion criterion [9], protocol p.40, in full: *"Have gradual and progressive
cognitive decline, as reported by the participant or by the study partner or
other informant, for ≥6 months from the time of signing the informed consent."*

This atom is the third reporter branch. The criterion accepts the report from any one of three sources — participant, study partner, or other informant. One satisfied reporter atom is enough; an unmet one disqualifies no one. At pre-screening this is the
branch that collateral history in the chart satisfies.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `TEMPORAL_DIRECTION_WORDING_AMBIGUOUS` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `condition_met` — a collateral account of decline from anyone other than the
  participant: spouse, adult child, other family, caregiver, facility staff —
  name the informant and their relationship in `rationale`
- `condition_not_met` — an informant affirmatively reports no decline (record
  it; one satisfied sibling branch still suffices)
- `unknown` — no collateral history in the record, which is common

Look in collateral/informant sections of neurology and memory-clinic notes,
social work assessments, nursing notes. Terms: per daughter, per spouse,
collateral history, informant, family reports, caregiver reports, accompanied by.

## Examples

- "Per daughter, progressive memory decline for about 2 years" → `condition_met`
- "Son states father is unchanged from baseline" → `condition_not_met`, recorded
- Chart contains no third-party account → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
