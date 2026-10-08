---
field_id: aacv_exc_026_a1
prompt: Does the chart document a known allergy to donanemab?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: allergy
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [allergy_documentation, anti_amyloid_agents]
---
# Criterion: Known allergy to donanemab
## Definition
AACV exclusion [26], p.42, verbatim: *"Have known allergies to donanemab, related compounds, or any components of the formulation, as described in the IB."* This atom is the donanemab limb; related compounds are `aacv_exc_026_a2` and formulation components `aacv_exc_026_a3`.

The three limbs sit under `OR` — any one met excludes the participant. A single affirmative no-known-drug-allergies statement bears on all three limbs, though for the formulation-components limb it must be paired with an allergy list free of vaccine or excipient entries (see `aacv_exc_026_a3`).
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `IB_NOT_SUPPLIED` (Manual review) — Review against the cited protocol text and document the adjudication.
- `RELATED_COMPOUNDS_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `FORMULATION_COMPONENT_SET_UNAVAILABLE` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
Donanemab is marketed as **Kisunla** and has been prescribable for early symptomatic Alzheimer disease since mid-2024, so prior exposure is possible outside a trial.

- `condition_met` — donanemab (or Kisunla) on the allergy list, or a documented hypersensitivity reaction during donanemab treatment
- `condition_not_met` — an affirmative no-known-drug-allergies statement (NKDA), or documented donanemab treatment with an affirmative note that it was tolerated (an exposure record merely silent about reactions → `unknown`)
- `unknown` — no exposure and no allergy statement, which will be the common answer

**A hypersensitivity reaction is not the same as ARIA.** Amyloid-related imaging abnormalities are an adverse effect, not an allergy; record ARIA in `rationale` if documented, but it does not satisfy this atom. **An empty allergy list is not NKDA** — absence of an entry is `unknown`. An affirmatively charted entry such as "Allergies: none" or "No known allergies" **is** an NKDA statement and counts.
Search terms: donanemab, Kisunla, infusion reaction, hypersensitivity, anaphylaxis, allergy list, NKDA.

## Examples
- Allergy list: "donanemab — infusion reaction, urticaria" → `condition_met`
- "Received donanemab x6 infusions, tolerated well" → `condition_not_met`
- "NKDA" → `condition_not_met`
- No donanemab exposure anywhere in the record, no allergy statement → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
