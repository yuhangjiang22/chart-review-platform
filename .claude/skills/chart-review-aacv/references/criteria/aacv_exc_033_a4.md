---
field_id: aacv_exc_033_a4
prompt: Has the investigator formed the opinion that another condition would contraindicate lumbar puncture in this participant?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: lp_contraindication
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [lumbar_puncture_barriers]
---
# Criterion: Other LP contraindication in the investigator's opinion
## Definition
AACV exclusion [33], p.43, final limb: *"Any other condition that, in the opinion of the investigator, would contraindicate lumbar puncture, for example, suspected increased intracranial pressure or an abnormality on MRI."*
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `OPEN_ENDED_OTHER_CONDITION` — recorded on this atom.
- `INVESTIGATOR_JUDGMENT_STANDARD_NOT_STATED` — recorded on this atom.
- `OPEN_ENDED_LP_CONTRAINDICATION_LIST` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SOURCE_USES_CONTRADICTION_NOT_CONTRAINDICATION_IN_SECOND_BULLET` (Manual review) — Review against the cited protocol text and document the adjudication.
- `CLINICAL_SIGNIFICANCE_AND_INVESTIGATOR_STANDARD_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
**This atom asks for an opinion formed by the trial investigator about this trial's lumbar puncture.** That opinion does not exist before the participant is screened.

Answer `unknown`, but **record any chart-findable barrier** so the investigator has it: a prior lumbar puncture that failed or required fluoroscopic or interventional-radiology guidance, lumbar fusion or instrumentation, laminectomy, severe spinal stenosis or scoliosis, a mass lesion or midline shift on prior brain imaging, Chiari malformation, or a platelet count the chart itself describes as markedly low. (The protocol sets no platelet cutoff — record the value and its date, do not apply one.) Search: fluoro-guided LP, IR-guided lumbar puncture, unsuccessful LP, traumatic tap, lumbar fusion, laminectomy, spinal stenosis.
- `unknown` — the expected answer. No chart contains this trial's investigator's opinion.
- `condition_met` — only if a clinician has explicitly documented that lumbar puncture is contraindicated for this patient
- `condition_not_met` — only on an explicit clinician statement that there is no contraindication to lumbar puncture ("no contraindication to LP", "cleared for lumbar puncture")
Do not infer the opinion from underlying findings. A documented raised ICP is evidence a clinician might reach that conclusion; it is not the conclusion.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
