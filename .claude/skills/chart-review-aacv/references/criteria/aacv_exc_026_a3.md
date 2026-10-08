---
field_id: aacv_exc_026_a3
prompt: Does the chart document a known allergy to a component of the donanemab formulation?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: allergy
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [allergy_documentation, anti_amyloid_agents]
---
# Criterion: Known allergy to a formulation component
## Definition
AACV exclusion [26], p.42, the *"any components of the formulation, as described in the IB"* limb.

> **The component list is not available.** The criterion defers to the Investigator's Brochure, which was not supplied to the parsing workbook (`IB_NOT_SUPPLIED`). Without it, no extractor can say what the components are, so this atom cannot be affirmed from the chart alone — only candidate evidence can be recorded.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `IB_NOT_SUPPLIED` — recorded on this atom.
- `IB_NOT_SUPPLIED` (Manual review) — Review against the cited protocol text and document the adjudication.
- `RELATED_COMPOUNDS_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `FORMULATION_COMPONENT_SET_UNAVAILABLE` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — do not use until the IB's component list is supplied
- `condition_not_met` — an affirmative no-known-drug-allergies statement **and** an allergy list with no vaccine or excipient entries — excipient hypersensitivity is often charted as a vaccine allergy, which "NKDA" does not cover
- `unknown` — everything else. **Record any documented excipient allergy in `rationale`** — polysorbate is the one worth actively looking for, since it is a common cause of injectable-drug hypersensitivity and a plausible formulation component — but whether it is in this formulation is exactly what the missing IB would say. (For the reviewer: polysorbate 80 appears in the US prescribing information of marketed donanemab/Kisunla; the IB remains the protocol's authority here, so the answer stays `unknown` — escalate any polysorbate allergy prominently.)
Search terms: polysorbate, excipient, PEG, polyethylene glycol, vaccine allergy, injectable allergy, allergy list.

## Examples
- "Allergy: polysorbate 80 — anaphylaxis" → `unknown`; recorded in `rationale` as candidate evidence pending the IB
- "NKDA", and the allergy list carries no vaccine or excipient entries → `condition_not_met`
- Allergy list has entries, none excipient-related → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
