---
field_id: aacv_inc_010_a5
prompt: Does the chart document spontaneous rest tremor as a cardinal feature of parkinsonism?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: dlb_core_features
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [parkinsonism]
---

# Criterion: Spontaneous rest tremor

## Definition

AACV inclusion [10], p.40 — parkinsonism, rest tremor limb. Protocol anchor: **at Visit 601**; for pre-screening this is read against the chart index date (02.3, an internal project-plan item).

> **Clinical description, not protocol text.** The protocol names the feature and cites McKeith et al. (2020) but does not reproduce that paper's definition, and the paper was not retrieved into the parsing workbook (flag `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED`). What follows is ordinary clinical usage, given so the extractor knows what wording to look for. It is not a threshold. If the chart does not plainly document the feature, answer `unknown`.

A **rest** tremor is
present when the limb is supported and at rest and typically damps with voluntary
movement. This is the distinguishing feature: essential tremor is an action or
postural tremor and does not satisfy this atom.

## Parkinsonism composition

Bradykinesia, rest tremor and rigidity together form the parkinsonism feature;
any one of the three is enough. Drug exposure is judged by the timing rules in
`aacv_inc_010_a4`, which apply to all three features.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `SOURCE_TEXT_SAYS_HAVE_LEAST_1_WITHOUT_AT` (Manual review) — Review against the cited protocol text and document the adjudication.
- `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED` (Manual review) — Review against the cited protocol text and document the adjudication.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `condition_met` — a tremor documented specifically at rest, with no drug cause
  stated or with drug exposure cleared by the timing rules in `aacv_inc_010_a4`
- `condition_not_met` — examination affirmatively addresses rest and finds no
  tremor ("no tremor", "no tremor at rest or with action")
- `unknown` — not addressed; or "tremor" documented without saying whether it is
  at rest; or a dopamine-blocking drug whose timing cannot be established

**Do not upgrade an unqualified "tremor" to a rest tremor.** If the note says only
"tremor", answer `unknown` and say so.

Terms: rest tremor, resting tremor, pill-rolling, tremor at rest, 4-6 Hz tremor.
Distinguish: essential tremor, intention tremor, postural tremor, action tremor.

## Examples

- "Pill-rolling rest tremor of the left hand" → `condition_met`
- "Bilateral action tremor, worse with sustained posture" → `unknown` — the
  character is recorded, but a note describing an action tremor does not affirm
  that rest was assessed, and rest tremor can coexist with essential tremor
- "Tremor noted" with no further description → `unknown`
- "No tremor at rest or with action" → `condition_not_met`
- Tremor not mentioned anywhere in the record → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
