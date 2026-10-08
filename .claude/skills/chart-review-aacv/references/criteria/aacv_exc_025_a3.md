---
field_id: aacv_exc_025_a3
prompt: Does the source state that the cancer is preventing completion of the study?
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
# Criterion: Cancer preventing study completion
## Definition
AACV exclusion [25], p.42, final limb: *"preventing the completion of the study"*.

> **This is a forward-looking judgment about this trial.** A chart written before the participant was ever considered for AACV cannot contain it. Record the cancer status and prognosis if documented, and answer `unknown`; the investigator makes the call.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `SOURCE_GRAMMAR_AMBIGUOUS_DO_NOT_REPAIR` — recorded on this atom.
- `SOURCE_GRAMMAR_AMBIGUOUS_DO_NOT_REPAIR` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- `INVESTIGATOR_OPINION_SCOPE_REQUIRES_CONFIRMATION` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- `HIGH_RISK_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Analyst note from the workbook: "The source grammar is preserved; no causal wording was inserted."
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `not_applicable` — no cancer history (`aacv_exc_025_a1` not met)
- if `aacv_exc_025_a1` is `unknown`, answer `unknown` here (not `not_applicable`)
- `unknown` — the expected answer. This is a judgment about a trial the chart's authors knew nothing about — unlike a recurrence-risk statement (`aacv_exc_025_a2`), which is trial-independent and can appear in a chart, *"preventing the completion of the study"* cannot, in either direction. There is deliberately no `condition_met` or `condition_not_met` path from notes.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
