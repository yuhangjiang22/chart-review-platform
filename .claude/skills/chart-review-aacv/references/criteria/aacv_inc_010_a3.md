---
field_id: aacv_inc_010_a3
prompt: Does the chart document REM sleep behavior disorder?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: dlb_core_features
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [dlb_rem_sleep_behavior_disorder]
---

# Criterion: REM sleep behavior disorder

## Definition

AACV inclusion [10], p.40, third core DLB feature. Protocol anchor: **at Visit 601**; for pre-screening this is read against the chart index date (02.3, an internal project-plan item).

> **Clinical description, not protocol text.** The protocol names the feature and cites McKeith et al. (2020) but does not reproduce that paper's definition, and the paper was not retrieved into the parsing workbook (flag `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED`). What follows is ordinary clinical usage, given so the extractor knows what wording to look for. It is not a threshold. If the chart does not plainly document the feature, answer `unknown`.

RBD is loss of the normal
atonia of REM sleep, so the person physically enacts dreams — talking, shouting,
punching, kicking, falling out of bed. It commonly precedes the cognitive
syndrome by years.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `SOURCE_TEXT_SAYS_HAVE_LEAST_1_WITHOUT_AT` (Manual review) — Review against the cited protocol text and document the adjudication.
- `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED` (Manual review) — Review against the cited protocol text and document the adjudication.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `condition_met` — RBD documented, either as a polysomnography-confirmed
  diagnosis or as a clear clinical description of dream enactment
- `condition_not_met` — dream enactment denied **with bed-partner or informant
  corroboration**. The patient is asleep during the behavior and cannot observe
  it, so a patient-only denial → `unknown`, denial recorded.
- `unknown` — not addressed

RBD is the feature most likely to carry a formal diagnosis and a coded entry
(ICD-10 G47.52) and a sleep-study report, so a structured check is worth doing
alongside the notes. Record which basis you used.

Do not confuse with obstructive sleep apnea, restless legs, periodic limb
movements, or simple nightmares — those are different and common. The
distinguishing feature is **physical enactment during dreaming**.

Look in sleep-medicine reports, neurology consults, and collateral history from a
bed partner, who is usually the person who noticed. Terms: REM sleep behavior
disorder, RBD, dream enactment, acting out dreams, punching or kicking in sleep,
falls out of bed, polysomnography, REM without atonia.

## Examples

- "Polysomnography confirms REM sleep behavior disorder" → `condition_met`
- "Wife reports he punches and shouts during sleep, has fallen out of bed" →
  `condition_met` on clinical description; note that it is not PSG-confirmed
- "Sleep history with wife present: snoring, treated OSA on CPAP, no dream
  enactment observed" → `condition_not_met`
- Patient alone denies acting out dreams, no bed-partner account → `unknown`
- No sleep history documented → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
