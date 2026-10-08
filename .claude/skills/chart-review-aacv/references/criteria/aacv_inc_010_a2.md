---
field_id: aacv_inc_010_a2
prompt: Does the chart document recurrent visual hallucinations?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: dlb_core_features
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [dlb_visual_hallucinations]
---

# Criterion: Recurrent visual hallucinations

## Definition

AACV inclusion [10], p.40, second core DLB feature. Protocol anchor: **at Visit 601**; for pre-screening this is read against the chart index date (02.3, an internal project-plan item).

> **Clinical description, not protocol text.** The protocol names the feature and cites McKeith et al. (2020) but does not reproduce that paper's definition, and the paper was not retrieved into the parsing workbook (flag `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED`). What follows is ordinary clinical usage, given so the extractor knows what wording to look for. It is not a threshold. If the chart does not plainly document the feature, answer `unknown`.

The McKeith criteria specify
**recurrent** visual hallucinations that are typically well formed and detailed —
classically people, children or animals.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `SOURCE_TEXT_SAYS_HAVE_LEAST_1_WITHOUT_AT` (Manual review) — Review against the cited protocol text and document the adjudication.
- `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED` (Manual review) — Review against the cited protocol text and document the adjudication.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `condition_met` — recurrent visual hallucinations documented. Record whether
  they are described as well formed, and whether the patient retains insight.
- `condition_not_met` — hallucinations affirmatively denied **with informant
  corroboration**. People with DLB often underreport or lack insight, so a
  patient-only denial → `unknown`, with the denial recorded.
- `unknown` — not addressed

**Attribution matters and is a known trap.** Visual hallucinations occurring only
during a delirium, only on a newly started dopaminergic or anticholinergic drug,
or only in the context of a primary psychotic illness are a different phenomenon.
Record any stated context in `rationale` rather than filtering the finding out
yourself — the attribution question is unresolved in the workbook for the related
psychiatric exclusion.

A single isolated episode is not "recurrent". Say in `rationale` whether
recurrence is documented or only one episode is.

Look in neurology, psychiatry, memory-clinic and collateral history. Terms:
visual hallucination, sees things, sees people who are not there, sees children
or animals, illusions, misperceptions, Charles Bonnet.

## Examples

- "Recurrent well-formed visual hallucinations of small children, patient retains
  insight" → `condition_met`
- "Saw bugs on the wall while febrile and delirious, resolved with treatment" →
  `unknown`, with the delirium context recorded
- "Denies hallucinations; spouse also reports none" → `condition_not_met`
- "Denies hallucinations on direct questioning", no informant account → `unknown`,
  denial recorded
- No mention → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
