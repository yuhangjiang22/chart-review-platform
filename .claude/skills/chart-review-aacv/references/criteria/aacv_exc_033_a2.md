---
field_id: aacv_exc_033_a2
prompt: Does the chart document a current blood-clotting or bleeding disorder?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: lp_contraindication
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [coagulopathy]
---
# Criterion: Current clotting or bleeding disorder
## Definition
AACV exclusion [33], p.43, second bullet, verbatim: *"A current blood-clotting or bleeding disorder, including clinically significant abnormal findings in laboratory assessments of coagulation or hematology, that in the opinion of the investigator would be a contradiction to lumbar puncture."*

Two things the criterion attaches that this atom does **not** decide: whether an abnormal finding is "clinically significant", and whether the investigator considers it a contraindication. Neither is defined in the protocol and neither exists in a pre-enrollment chart. This atom records the disorder or the abnormal finding; the investigator judges it.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `CLINICALLY_SIGNIFICANT_NOT_DEFINED` — recorded on this atom.
- `SOURCE_WORDING_USES_CONTRADICTION_POSSIBLE_TYPO_NOT_REPAIRED` — recorded on this atom.
- `OPEN_ENDED_LP_CONTRAINDICATION_LIST` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SOURCE_USES_CONTRADICTION_NOT_CONTRAINDICATION_IN_SECOND_BULLET` (Manual review) — Review against the cited protocol text and document the adjudication.
- `CLINICAL_SIGNIFICANCE_AND_INVESTIGATOR_STANDARD_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — a current coagulopathy or bleeding disorder is documented (hemophilia, von Willebrand disease, DIC, cirrhosis-associated coagulopathy, or thrombocytopenia that the chart documents as a bleeding disorder or describes as significant or severe), or coagulation labs are described as clinically significantly abnormal. Incidental mild thrombocytopenia is common at this age and is not by itself a bleeding disorder — record the value and date and answer `unknown` (the protocol sets no cutoff; see `aacv_exc_033_a4`).
- `condition_not_met` — affirmative statement of normal coagulation or absence of a bleeding disorder
- `unknown` — not addressed, or lab values present without a reference range or interpretation
Cite the diagnosis statement or the interpreted lab. **Do not apply your own cutoff to a raw INR or platelet count** — the protocol does not define one.
Search terms: coagulopathy, bleeding disorder, thrombocytopenia, hemophilia, von Willebrand, INR, PT, PTT, platelets, DIC, easy bruising.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
