---
field_id: aacv_exc_031_a2
prompt: Does the chart document a sensitivity or adverse reaction to an amyloid PET tracer?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: pet_contraindication
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [amyloid_tracers, allergy_documentation]
---
# Criterion: Sensitivity to the amyloid PET tracer
## Definition
AACV exclusion [31], p.43, the tracer limb.
The criterion text does not name the tracer. Section 8.7.3.1 of the same protocol does: *"Florbetapir or florbetaben will be used for the amyloid PET scan in this study."*

So the agents in scope are **florbetapir F 18** and **florbetaben F 18**. That is a cross-reference this rubric supplies, **not** a closure of the workbook flags `AMYLOID_PET_TRACER_NOT_IDENTIFIED_IN_CRITERION` and `TRACER_NOT_IDENTIFIED_IN_CRITERION`, which remain open below. Extract against these two agents and let the reviewer confirm the cross-reference.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `AMYLOID_PET_TRACER_NOT_IDENTIFIED_IN_CRITERION` — recorded on this atom.
- `OPEN_ENDED_AMYLOID_PET_CONTRAINDICATION` (Manual review) — Review against the cited protocol text and document the adjudication.
- `TRACER_NOT_IDENTIFIED_IN_CRITERION` (Manual review) — Review against the cited protocol text and document the adjudication.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — a documented allergy or adverse reaction to florbetapir or florbetaben
- `condition_not_met` — a prior amyloid PET with either tracer completed and tolerated, or an allergy list that affirmatively excludes them
- `unknown` — no exposure documented, which will be the common answer. Most candidates have never received an amyloid tracer, so the field is empty rather than negative.
**An empty allergy list is not evidence of no allergy** (an affirmatively charted "Allergies: none" is). Answer `condition_not_met` only on positive evidence: a tolerated prior exposure, or an explicit statement.
Other radiopharmaceutical reactions (FDG, technetium) are related but not the same agent. Record them and say so in `rationale` rather than treating them as this atom.
Terms: florbetapir, Amyvid, florbetaben, Neuraceq, amyloid PET, radiopharmaceutical reaction, contrast reaction, tracer.
## Examples
- "Amyvid PET 2024, no adverse reaction" → `condition_not_met`
- "Reaction to florbetaben during prior imaging" → `condition_met`
- "Allergy to iodinated contrast" → `unknown` for this atom; note the contrast allergy in `rationale`, since it is a different agent class
- Allergy list present, no radiopharmaceutical entries, no prior amyloid imaging → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
