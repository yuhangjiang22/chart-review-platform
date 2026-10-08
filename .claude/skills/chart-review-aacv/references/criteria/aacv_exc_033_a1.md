---
field_id: aacv_exc_033_a1
prompt: Does the chart document an allergy to a local anesthetic such as lidocaine?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: lp_contraindication
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [local_anesthetic_allergy, allergy_documentation]
---
# Criterion: Local anesthetic allergy
## Definition
AACV exclusion [33], p.43, first bullet: *"Allergy to local anesthetics, such as lidocaine."*
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `LOCAL_ANESTHETIC_EXAMPLE_IS_NONEXHAUSTIVE` — recorded on this atom.
- `OPEN_ENDED_LP_CONTRAINDICATION_LIST` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SOURCE_USES_CONTRADICTION_NOT_CONTRAINDICATION_IN_SECOND_BULLET` (Manual review) — Review against the cited protocol text and document the adjudication.
- `CLINICAL_SIGNIFICANCE_AND_INVESTIGATOR_STANDARD_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — allergy to lidocaine or another local anesthetic documented
- `condition_not_met` — NKDA stated (a charted "Allergies: none" counts), or an allergy list that affirmatively excludes anesthetics; apply one NKDA-style statement consistently across all the allergy atoms
- `unknown` — allergy list empty or silent on anesthetics
Search terms: lidocaine, xylocaine, bupivacaine, novocaine, procaine, local anesthetic allergy.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
