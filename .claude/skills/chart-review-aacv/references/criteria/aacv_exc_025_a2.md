---
field_id: aacv_exc_025_a2
prompt: In the investigator's opinion, does the participant's cancer carry a high risk of recurrence?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: oncology
polarity: exclusion
eligibility_role: DISQUALIFYING
is_applicable_when: 'aacv_exc_025_a1 == "condition_met"'
uses:
  keyword_sets: [cancer_history]
---
# Criterion: Investigator opinion — recurrence risk
## Definition
AACV exclusion [25], p.42: *"…that, in the investigator's opinion, has a high risk of recurrence…"*
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `SOURCE_GRAMMAR_AMBIGUOUS_DO_NOT_REPAIR` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- `INVESTIGATOR_OPINION_SCOPE_REQUIRES_CONFIRMATION` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- `HIGH_RISK_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `not_applicable` — no cancer history (`aacv_exc_025_a1` not met)
- if `aacv_exc_025_a1` is `unknown`, answer `unknown` here (not `not_applicable`)
- `unknown` — the expected answer when a cancer history exists. This is the trial investigator's forward-looking risk judgment; it is not in a chart.
- `condition_met` — only if an oncologist has explicitly documented high recurrence risk
- `condition_not_met` — the treating clinician affirmatively documents low recurrence risk or cure ("considered cured", "no evidence of disease, surveillance complete", "low risk of recurrence")
An oncologist's surveillance plan is evidence a clinician is watching for recurrence; it is not a statement of high risk.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
