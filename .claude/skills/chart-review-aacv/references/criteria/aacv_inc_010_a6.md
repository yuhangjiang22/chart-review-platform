---
field_id: aacv_inc_010_a6
prompt: Does the chart document spontaneous rigidity as a cardinal feature of parkinsonism?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: dlb_core_features
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [parkinsonism]
---

# Criterion: Spontaneous rigidity

## Definition

AACV inclusion [10], p.40 — parkinsonism, rigidity limb. Protocol anchor: **at Visit 601**; for pre-screening this is read against the chart index date (02.3, an internal project-plan item).

> **Clinical description, not protocol text.** The protocol names the feature and cites McKeith et al. (2020) but does not reproduce that paper's definition, and the paper was not retrieved into the parsing workbook (flag `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED`). What follows is ordinary clinical usage, given so the extractor knows what wording to look for. It is not a threshold. If the chart does not plainly document the feature, answer `unknown`.

Rigidity is increased
resistance to passive movement that is present throughout the range and in both
directions, often with a cogwheel quality. It is distinct from spasticity, which
is velocity-dependent and accompanies upper motor neuron signs.

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

- `condition_met` — rigidity or cogwheeling documented on examination, with no
  drug cause stated or with drug exposure cleared by the timing rules in
  `aacv_inc_010_a4`
- `condition_not_met` — examination affirmatively records normal tone
- `unknown` — not addressed, or increased tone described without distinguishing
  rigidity from spasticity, or a dopamine-blocking drug whose timing cannot be
  established

Terms: rigidity, cogwheel rigidity, cogwheeling, increased tone, lead-pipe
rigidity. Distinguish: spasticity, clasp-knife, hypertonia of UMN origin,
paratonia.

## Examples

- "Cogwheel rigidity at both wrists" → `condition_met`
- "Increased tone in the right arm with brisk reflexes and upgoing plantar" →
  `unknown`; that pattern is spastic (upper motor neuron), which does not affirm
  the absence of extrapyramidal rigidity elsewhere — record it in `rationale`
- "Tone normal throughout" → `condition_not_met`
- No neurological examination in the record → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
