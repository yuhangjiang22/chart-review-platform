---
field_id: aacv_inc_009_a2
prompt: Is the participant's cognitive decline documented as progressive (worsening over time)?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: cognition
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [cognitive_decline]
---

# Criterion: Cognitive decline — progressive

## Definition

AACV inclusion criterion [9], protocol p.40, in full: *"Have gradual and progressive
cognitive decline, as reported by the participant or by the study partner or
other informant, for ≥6 months from the time of signing the informed consent."*

This atom covers **progressive** only — the decline worsens over time. The
protocol does not define the term; record the chart's own trajectory language.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `TEMPORAL_DIRECTION_WORDING_AMBIGUOUS` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `condition_met` — worsening over time documented: "progressive", serial
  cognitive scores that fall, or an informant describing continued worsening
- `condition_not_met` — the deficit is affirmatively described as static or
  improving (a fixed post-event deficit stable for years, or recovery after a
  delirium)
- `unknown` — decline documented once with no trajectory information

Two dated data points beat one adjective: if serial scores exist, cite both with
dates. A single evaluation cannot establish progression — that is `unknown`.

Terms: progressive, worsening, declining, deteriorating, compared with prior
testing, follow-up MoCA/MMSE, stable, unchanged, improved.

## Examples

- "MoCA 24 (2024) → 19 (2026)" → `condition_met`, both scores and dates cited
- "Progressive decline per daughter" → `condition_met`
- "Deficits stable since her 2019 stroke, no progression" → `condition_not_met`
- One evaluation, no prior comparison, no trajectory words → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
