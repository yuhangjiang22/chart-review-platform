---
field_id: aacv_exc_031_a1
prompt: Does the chart document any contraindication to undergoing a PET scan?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: pet_contraindication
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [pet_procedure_tolerance]
---
# Criterion: Contraindication to the amyloid PET procedure
## Definition
AACV exclusion [31], p.43: *"Have any contraindication to the amyloid PET procedure or sensitivity to the amyloid PET tracer."* This atom is the procedure limb; tracer sensitivity is `aacv_exc_031_a2`.
This is about whether the person can undergo the scan, not about whether a scan has been ordered.

**This is procedurally distinct from the MRI-contraindication criterion, protocol [30].** Implanted-metal contraindications — pacemaker, ICD, cochlear implant, aneurysm clip, intraocular foreign body — do not transfer to PET, and a PET/CT gantry, while longer than a plain CT ring, is far better tolerated than an MRI bore. Claustrophobia or inability to lie still can still preclude PET — judge them on PET-relevant evidence, and do not import an MRI finding as a PET finding.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `OPEN_ENDED_CONTRAINDICATION_CATEGORY` — recorded on this atom.
- `OPEN_ENDED_AMYLOID_PET_CONTRAINDICATION` (Manual review) — Review against the cited protocol text and document the adjudication.
- `TRACER_NOT_IDENTIFIED_IN_CRITERION` (Manual review) — Review against the cited protocol text and document the adjudication.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

> ***"Any contraindication"* is not defined in the protocol** — the workbook flags it as an open-ended category. The reasons below are ordinary clinical usage of what prevents a PET, not a protocol list, and must not be treated as exhaustive or authoritative.

- `condition_met` — a documented **medical** reason the patient cannot undergo PET: inability to lie still or flat for the acquisition, claustrophobia that has prevented supine gantry imaging, or a clinician statement that the procedure is contraindicated. A refusal or stated preference is a willingness question, not a contraindication — record it and answer `unknown`.
- `condition_not_met` — a completed PET (or comparable supine gantry study, e.g. PET/CT or DaTscan) in the record is good evidence the patient tolerates the procedure; weigh recency — in a progressive dementia, a scan tolerated years ago is weaker evidence about now
- `unknown` — nothing addresses it, which will be the common answer
A prior completed PET is the strongest available negative evidence. Look in nuclear-medicine and radiology reports, anesthesia and sedation notes, and prior imaging that was abandoned or required sedation.
Terms: PET, nuclear medicine, claustrophobia, unable to lie flat, sedation for imaging, study terminated, patient unable to tolerate, refused imaging.

## Examples
- "PET/CT completed 2025-06, no complications" → `condition_not_met`
- "Unable to complete MRI due to severe claustrophobia, required sedation" → `unknown` for PET; record the MRI intolerance in `rationale` as a flag for the investigator
- "Patient declines all nuclear medicine studies" → `unknown`; a stated preference is a willingness question, not a medical contraindication. Record it in `rationale`.
- Nothing on imaging tolerance anywhere → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
