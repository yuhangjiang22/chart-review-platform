---
field_id: aacv_inc_009_a1
prompt: Is the participant's cognitive decline documented as gradual in onset and course?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: cognition
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [cognitive_decline]
---

# Criterion: Cognitive decline — gradual

## Definition

AACV inclusion criterion [9], protocol p.40, in full: *"Have gradual and progressive
cognitive decline, as reported by the participant or by the study partner or
other informant, for ≥6 months from the time of signing the informed consent."*

This atom covers **gradual** only; progression is `aacv_inc_009_a2`, duration
`aacv_inc_009_a3`; who reported it is covered by the three reporter atoms
(`aacv_inc_009_a4`, `aacv_inc_009_a5`, `aacv_inc_009_a6`). The protocol does
not define "gradual"; record the chart's own course language.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `TEMPORAL_DIRECTION_WORDING_AMBIGUOUS` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `condition_met` — the course is described as gradual, insidious, slowly
  progressive, or "over months to years" with no abrupt onset
- `condition_not_met` — an affirmatively abrupt or acute onset is documented
  (sudden onset after a stroke or surgery, decline over days to weeks)
- `unknown` — decline documented with no description of onset or course

Quote the course words verbatim in `rationale`. A stepwise course (typical of
vascular cognitive impairment) is neither clearly gradual nor abrupt — record it
and answer `unknown`; the distinction is a clinical read for the reviewer.

Look in neurology and memory-clinic consults, primary care notes and collateral
history. Terms: gradual, insidious, slowly progressive, over the past year,
progressive decline, sudden onset, abrupt, stepwise.

## Examples

- "Gradual cognitive decline over 2-3 years per spouse" → `condition_met`
- "Acute confusion since bypass surgery in March, not improved" → `condition_not_met`
- "Memory loss" on a problem list, no course described → `unknown`
- "Stepwise decline, each episode following a hospitalization" → `unknown`, course recorded

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
