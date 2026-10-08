---
field_id: aacv_exc_018_a1
prompt: In the investigator's opinion, does the participant have a disease or condition that could interfere with this study?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: general_health
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [serious_unstable_illness]
---
# Criterion: Investigator opinion — condition interfering with the study
## Definition
AACV exclusion [18], p.41, first limb: a disease or condition that, *"in the investigator's opinion, could interfere with this study"*.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `INVESTIGATOR_OPINION_SCOPE_AMBIGUOUS` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- `NONEXHAUSTIVE_EXAMPLE_LIST_NOT_MODELED_AS_CLOSED_OR` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SERIOUS_AND_UNSTABLE_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
**This is the trial investigator's opinion about this trial.** It does not exist in a chart written before the trial.

Unlike a lumbar-puncture contraindication or a cancer-recurrence judgment — trial-independent clinical judgments a treating clinician can put in a chart (`aacv_exc_033_a4` under criterion [33], `aacv_exc_025_a2` under criterion [25]) — *"could interfere with this study"* is a statement about this trial, so no prior chart can carry it in either direction. There is deliberately no `condition_met` or `condition_not_met` path from notes.
- `unknown` — the expected answer. Record any condition a reviewer should weigh (poor anticipated compliance, conditions likely to disrupt participation) in `rationale`.
Do not substitute your own judgment about what might interfere with a trial the chart's authors knew nothing about.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
