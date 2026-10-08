---
field_id: aacv_exc_028_a1
prompt: Is there a documented diagnosis of alcohol use disorder within 2 years of the index date?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: substance_use
polarity: exclusion
eligibility_role: DISQUALIFYING
time_window:
  anchor: visit_1
  relation: before
  bound_years: 2
uses:
  keyword_sets: [substance_use_disorder]
---
# Criterion: Alcohol use disorder diagnosis within 2 years
## Definition
AACV exclusion [28], p.43, in full: *"Have a diagnosis of alcohol or drug use disorder, except tobacco use disorder, within 2 years of Visit 1."* This atom covers the alcohol limb; the non-tobacco drug limb is `aacv_exc_028_a2`.
The protocol says **diagnosis**. Drinking, however heavy, is not a diagnosis.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `TWO_YEAR_BOUNDARY_INCLUSIVITY_NOT_STATED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `DIAGNOSTIC_SYSTEM_OR_CODE_SET_NOT_STATED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `TOBACCO_EXCEPTION_APPLIES_TO_TOBACCO_DIAGNOSIS_NOT_CONCURRENT_NONTOBACCO_DISORDER` (Temporal interpretation) — Confirm anchor, boundary inclusivity, and calculation rule before implementation.
- `TOBACCO_MODELED_AS_DIAGNOSIS_SET_FILTER` (Manual review) — Review against the cited protocol text and document the adjudication.
- `CONCURRENT_NONTOBACCO_DISORDER_REMAINS_EXCLUSIONARY` (Temporal interpretation) — Confirm anchor, boundary inclusivity, and calculation rule before implementation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — a clinician-documented diagnosis of alcohol use disorder, alcohol dependence or alcohol abuse, dated within the window
- `condition_not_met` — the chart affirmatively states no such diagnosis, or the disorder is documented as resolved or in remission **since before the window began** (a remission date alone places the disorder outside the window)
- `unknown` — drinking is described but no diagnosis is recorded; or a diagnosis is recorded with neither a diagnosis date nor a remission date; or the topic is not addressed
**A diagnosis date outside the window does not clear the criterion by itself.** *"within 2 years"* is about when the disorder is present, not when the diagnostic act happened: AUD first diagnosed in 2020 that is still active inside the window is within the window. Ongoing maintenance treatment with documented remission is a boundary case — record both facts and answer `unknown` for the reviewer.
**The commonest error on this criterion is treating consumption as diagnosis.** "Drinks 2-3 beers nightly", "heavy drinker", "counseled on alcohol intake" are consumption. "Meets criteria for AUD", "alcohol dependence", an F10.x problem-list entry are diagnoses.
Look in psychiatry and behavioral-health notes, the social history of an H&P, problem lists, discharge summaries and social work assessments. Terms: alcohol use disorder, AUD, alcohol dependence, alcohol abuse, alcoholism, ETOH abuse, in recovery, sober since, detox, withdrawal, CIWA, AUDIT-C.

Cite the diagnosis statement and its date. Record the date as written; if only a relative expression is available ("diagnosed a few years ago") record the phrase and the note date rather than converting it.

## Examples
- "Alcohol use disorder, diagnosed 03/2025, engaged in treatment" → `condition_met`
- "History of alcohol dependence, in remission since 2018" → `condition_not_met` — the remission date places the disorder before any 2-year window at a 2026 index date; record the remission date and note that no diagnosis date is given
- "Drinks 2-3 beers nightly" with no diagnosis → `condition_not_met` is wrong; answer `unknown`
- "Denies alcohol use" → `unknown` — that is a consumption statement, not a diagnosis statement, and people in recovery from a recent AUD diagnosis routinely deny current use
- No mention of alcohol anywhere → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
