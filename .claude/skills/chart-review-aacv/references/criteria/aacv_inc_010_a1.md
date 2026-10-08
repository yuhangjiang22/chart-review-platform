---
field_id: aacv_inc_010_a1
prompt: Does the chart document fluctuating cognition with pronounced variations in attention and alertness?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: dlb_core_features
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [dlb_fluctuating_cognition]
---

# Criterion: Fluctuating cognition

## Definition

AACV inclusion [10], p.40: at least one core clinical feature of dementia with
Lewy bodies per McKeith et al. (2020), *"based on the investigator's assessment,
**previous testing, or medical history** at Visit 601"*. Two of those three sources are
pre-existing chart content, which is why this is answerable before enrollment.
The protocol's anchor is **Visit 601**, the trial's own prescreening visit; for
pre-screening, read against the chart index date instead (02.3 — an internal
project-plan item, not a protocol section).

This atom is the first core feature: **fluctuating cognition with pronounced
variations in attention and alertness**.

> **Clinical description, not protocol text.** The protocol names the feature and cites McKeith et al. (2020) but does not reproduce that paper's definition, and the paper was not retrieved into the parsing workbook (flag `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED`). What follows is ordinary clinical usage, given so the extractor knows what wording to look for. It is not a threshold. If the chart does not plainly document the feature, answer `unknown`.

Not ordinary day-to-day variability —
the DLB phenomenon is marked, often described by family as the patient "going
blank", staring, or being transiently unrousable, alternating with lucid periods.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `SOURCE_TEXT_SAYS_HAVE_LEAST_1_WITHOUT_AT` (Manual review) — Review against the cited protocol text and document the adjudication.
- `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED` (Manual review) — Review against the cited protocol text and document the adjudication.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `condition_met` — the chart describes marked fluctuation in attention,
  alertness or coherence: staring spells, transient unresponsiveness, "good days
  and bad days" of a pronounced kind, daytime drowsiness with lucid intervals,
  or a documented fluctuation scale
- `condition_not_met` — an informant-based or longitudinal statement that there
  is no fluctuation. A single cross-sectional exam cannot refute an episodic
  phenomenon — that is `unknown`.
- `unknown` — not addressed. Fluctuation is only documented when someone asked
  about it, so absence is common and means nothing.

The protocol lists **four** core features and requires at least one, so a single
clear description here settles criterion [10] positively. (The fourth feature,
parkinsonism, is split into three atoms — bradykinesia, rest tremor, rigidity —
which is why there are six atoms and four features.)

Look in neurology and memory-clinic consults, collateral history from family,
and geriatrics notes. Terms: fluctuating cognition, fluctuations, waxing and
waning, staring spells, zoning out, goes blank, variable alertness, daytime
somnolence, lucid intervals, delirium-like episodes without a cause.

Distinguish from delirium with an identified cause (infection, medication) —
record the context in `rationale` if one is stated.

## Examples

- "Family reports episodes of staring and unresponsiveness lasting minutes,
  alternating with normal conversation" → `condition_met`
- "Marked day-to-day variation in alertness per spouse" → `condition_met`
- "No fluctuations per spouse; alertness consistent day to day" → `condition_not_met`
- "Cognition stable, no fluctuation noted on exam" (single visit, no informant) →
  `unknown`
- Memory complaints documented, nothing about fluctuation → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
