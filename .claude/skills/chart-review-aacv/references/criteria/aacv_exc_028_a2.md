---
field_id: aacv_exc_028_a2
prompt: Is there a documented diagnosis of a non-tobacco drug use disorder within 2 years of the index date?
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
# Criterion: Non-tobacco drug use disorder within 2 years
## Definition
AACV exclusion [28], p.43, the drug limb. The protocol excludes **tobacco use disorder** from the criterion, so a tobacco diagnosis alone does not satisfy this atom.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `DIAGNOSIS_LEVEL_TOBACCO_FILTER_REQUIRED` — recorded on this atom.
- `TWO_YEAR_BOUNDARY_INCLUSIVITY_NOT_STATED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `DIAGNOSTIC_SYSTEM_OR_CODE_SET_NOT_STATED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `TOBACCO_EXCEPTION_APPLIES_TO_TOBACCO_DIAGNOSIS_NOT_CONCURRENT_NONTOBACCO_DISORDER` (Temporal interpretation) — Confirm anchor, boundary inclusivity, and calculation rule before implementation.
- `TOBACCO_MODELED_AS_DIAGNOSIS_SET_FILTER` (Manual review) — Review against the cited protocol text and document the adjudication.
- `CONCURRENT_NONTOBACCO_DISORDER_REMAINS_EXCLUSIONARY` (Temporal interpretation) — Confirm anchor, boundary inclusivity, and calculation rule before implementation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — a clinician-documented substance use disorder other than tobacco, dated within the window. Record the substance.
- `condition_not_met` — affirmatively no such diagnosis, or the disorder is documented as resolved or in remission **since before the window began**. A tobacco-only diagnosis does not satisfy the atom, but by itself it is not affirmative evidence that no other disorder exists — see the examples.
- `unknown` — substance use described without a diagnosis; diagnosis with no date; topic not addressed
As with the alcohol limb, use is not diagnosis. Cannabis use in a legal-use state, or a documented prescription opioid, is not by itself a disorder.
Terms: substance use disorder, SUD, opioid use disorder, OUD, cocaine, methamphetamine, stimulant use disorder, cannabis use disorder, polysubstance, F11-F19, MAT, buprenorphine, methadone, naltrexone.

## Examples
- "Opioid use disorder, on buprenorphine since 2025" → `condition_met`, substance recorded
- "Tobacco use disorder" and nothing else → `unknown` — tobacco does not satisfy the atom, and a tobacco-only list does not affirm that no other disorder was diagnosed
- "Tobacco use disorder; cannabis use disorder, diagnosed 06/2025" → `condition_met` on the cannabis diagnosis
- "OUD in sustained remission, on buprenorphine maintenance" → `unknown` — remission is documented but treatment continues inside the window; whether that keeps the diagnosis *"within 2 years"* is the reviewer's call
- "Occasional cannabis use" with no diagnosis → `unknown`
- No mention → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
