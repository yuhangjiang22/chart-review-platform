---
field_id: aacv_exc_033_a3
prompt: Does the chart document a medical condition requiring treatment with an anticoagulant?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: lp_contraindication
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [anticoagulation]
---
# Criterion: Condition requiring anticoagulation
## Definition
AACV exclusion [33], p.43, third bullet — *"such as heparin, vitamin K antagonists, or direct acting oral anticoagulants"*.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `ANTICOAGULANT_EXAMPLES_ARE_NONEXHAUSTIVE` — recorded on this atom.
- `OPEN_ENDED_LP_CONTRAINDICATION_LIST` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SOURCE_USES_CONTRADICTION_NOT_CONTRAINDICATION_IN_SECOND_BULLET` (Manual review) — Review against the cited protocol text and document the adjudication.
- `CLINICAL_SIGNIFICANCE_AND_INVESTIGATOR_STANDARD_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — an active anticoagulant with a documented indication (AF, VTE, mechanical valve), **or a chronic outpatient anticoagulant** (warfarin, a DOAC, or long-term LMWH continued across visits) even when the indication is not restated — therapeutic anticoagulants are not prescribed without a qualifying condition. For the no-indication path require one corroborating signal that the drug is actually being taken (a recent fill or administration record, INR monitoring for warfarin, or the drug in a recent note's assessment/plan); a medication-list entry alone can be a stale, never-removed order. Cite the drug, its duration and the corroboration — the corroborating signal must appear in the chart text you quote. A medication name alone in a discharge or admission list, with nothing quoted to show ongoing outpatient use, is `unknown`.
- `condition_not_met` — affirmative statement that the patient is on no anticoagulation
- `unknown` — medication list silent; an anticoagulant appearing only in a single perioperative or inpatient context (short-course prophylaxis is not evidence of a chronic condition); or a list entry with no corroborating signal of active therapy — record it **prominently** for the reviewer
**Antiplatelets are not anticoagulants** — aspirin and clopidogrel alone do not satisfy this.
Search terms: warfarin, coumadin, apixaban, eliquis, rivaroxaban, xarelto, dabigatran, heparin, enoxaparin, lovenox, DOAC, anticoagulation, atrial fibrillation, DVT, PE.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
