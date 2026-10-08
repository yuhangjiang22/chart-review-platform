---
field_id: aacv_exc_027_a2
prompt: Does the chart document a clinically significant **severe** drug allergy?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: allergy
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [allergy_documentation, hypersensitivity_severity]
---
# Criterion: Severe drug allergy
## Definition
AACV exclusion [27], p.42, the **severe** limb of *"Have clinically significant multiple or severe drug allergies, significant atopy, or severe posttreatment hypersensitivity reactions."*

> **Not defined in the protocol.** The protocol gives no definition, threshold or instrument for "severe". Anything below is ordinary clinical usage, written so the extractor knows what text to look for — it is **not** a protocol standard. The deciding evidence must always be the chart's **own** characterization; the material below only shows what that characterization typically looks like. Concretely: the qualifying word must appear in the chart text you quote — **if it appears only in your own rationale, it is your judgment, and the answer is `unknown`**. Where the chart does not supply it, answer `unknown` and let the reviewer judge.

The reactions named in the `condition_met` rule are the ones clinicians usually document as severe. They are a search aid, not a protocol list.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `CLINICALLY_SIGNIFICANT_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `MULTIPLE_COUNT_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `SEVERE_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `SIGNIFICANT_ATOPY_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — a documented severe reaction: anaphylaxis, angioedema, Stevens-Johnson syndrome, TEN, DRESS, or a reaction requiring epinephrine, admission or ICU care
- `condition_not_met` — allergies documented, all mild (rash, nausea, GI upset) and explicitly so
- `unknown` — allergies listed with no reaction description, or list empty
Cite the reaction words, not the drug name alone. Search terms: anaphylaxis, angioedema, Stevens-Johnson, SJS, TEN, DRESS, epinephrine, hives, urticaria, swelling of throat/tongue.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
