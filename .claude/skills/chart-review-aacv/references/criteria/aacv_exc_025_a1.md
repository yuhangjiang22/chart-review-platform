---
field_id: aacv_exc_025_a1
prompt: Does the chart document a history of cancer?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: oncology
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [cancer_history]
---
# Criterion: History of cancer — any prior malignancy
## Definition
AACV exclusion [25], p.42, base limb. The temporal window is **ever** — any prior cancer counts for this atom.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `SOURCE_GRAMMAR_AMBIGUOUS_DO_NOT_REPAIR` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- `INVESTIGATOR_OPINION_SCOPE_REQUIRES_CONFIRMATION` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- `HIGH_RISK_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — any documented malignancy, current or historical, with dates where stated
- `condition_not_met` — an affirmative statement of no cancer history (e.g. "no history of malignancy" in a review of systems or oncology screen)
- `unknown` — not addressed
Non-melanoma skin cancer is still a malignancy; record it and note the type rather than filtering it yourself.
Search terms: cancer, carcinoma, malignancy, neoplasm, tumor, chemotherapy, radiation therapy, oncology, remission, NED.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
