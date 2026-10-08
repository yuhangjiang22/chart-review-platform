---
field_id: aacv_inc_009_a5
prompt: Is the cognitive decline reported by the participant's study partner?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: cognition
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [informant_collateral]
---

# Criterion: Decline reported by the study partner

## Definition

AACV inclusion criterion [9], protocol p.40, in full: *"Have gradual and progressive
cognitive decline, as reported by the participant or by the study partner or
other informant, for ≥6 months from the time of signing the informed consent."*

This atom is the second reporter branch. The criterion accepts the report from any one of three sources — participant, study partner, or other informant. One satisfied reporter atom is enough; an unmet one disqualifies no one.

**Before enrollment, nobody formally holds the study-partner role**, so this
branch is usually not satisfiable as written. The report itself can already
exist — the spouse or caregiver giving collateral history is typically the
person who will later serve as study partner — but until they are enrolled it is
an informant report, credited under `aacv_inc_009_a6`.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `TEMPORAL_DIRECTION_WORDING_AMBIGUOUS` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `unknown` — the expected answer at pre-screening: the study-partner role does
  not exist yet. When a likely future study partner (spouse, adult child,
  primary caregiver) has given a collateral account, say so in `rationale` and
  credit the account under `aacv_inc_009_a6`; the criterion is satisfied through
  that branch regardless of this one.

Do not answer `condition_met` here before enrollment.

## Examples

- "Wife reports decline over 18 months" → this atom: `unknown`, noting the wife
  is a likely study partner; `aacv_inc_009_a6`: `condition_met`
- No collateral history at all → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
