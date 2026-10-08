---
field_id: aacv_exc_027_a1
prompt: Does the chart document clinically significant **multiple** drug allergies?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: allergy
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [allergy_documentation]
---
# Criterion: Multiple drug allergies
## Definition
AACV exclusion [27], p.42: *"Have clinically significant multiple or severe drug allergies…"*
This atom covers **multiple** drug allergies only; severity is `aacv_exc_027_a2`.

> **Not defined in the protocol.** The protocol gives no definition, threshold or instrument for "clinically significant", or for how many allergies count as "multiple". Anything below is ordinary clinical usage, written so the extractor knows what text to look for — it is **not** a protocol standard. The deciding evidence must always be the chart's **own** characterization; the material below only shows what that characterization typically looks like. Concretely: the qualifying word must appear in the chart text you quote — **if it appears only in your own rationale, it is your judgment, and the answer is `unknown`**. Where the chart does not supply it, answer `unknown` and let the reviewer judge.

The workbook records this as an open flag. Two or more is the reading used below because the word is plural; it is an assumption, not a protocol rule, and the count belongs in `rationale` so the reviewer can apply their own.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `CLINICALLY_SIGNIFICANT_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `MULTIPLE_COUNT_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `SEVERE_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `SIGNIFICANT_ATOPY_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — the allergy list or narrative documents allergies to two or more distinct drugs or drug classes, described as clinically significant
- `condition_not_met` — the chart affirmatively states no known drug allergies (NKDA). A list carrying a single entry does not affirm that no second allergy exists — record the entry and answer `unknown`.
- `unknown` — the allergy list is empty with no NKDA statement, or reactions are recorded without enough detail to judge significance
**An empty allergy list is not NKDA.** Absence of recorded allergies is `unknown`, never `condition_not_met`. An affirmatively charted entry such as "Allergies: none" **is** an NKDA statement and counts. Apply one NKDA-style statement consistently across all the allergy atoms — the same evidence should not settle one and leave a sibling `unknown`.
Search: allergy list, H&P allergy section, allergy/immunology consult. Terms: allergy, allergic, intolerance, adverse drug reaction, NKDA.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
