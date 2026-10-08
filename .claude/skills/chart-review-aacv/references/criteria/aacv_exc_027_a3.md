---
field_id: aacv_exc_027_a3
prompt: Does the chart document significant atopy?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: allergy
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [atopy]
---
# Criterion: Significant atopy
## Definition
AACV exclusion [27], p.42, the **significant atopy** limb.

> **Not defined in the protocol.** The protocol gives no definition, threshold or instrument for "atopy", and none for what makes atopy "significant". Anything below is ordinary clinical usage, written so the extractor knows what text to look for — it is **not** a protocol standard. The deciding evidence must always be the chart's **own** characterization; the material below only shows what that characterization typically looks like. Concretely: the qualifying word must appear in the chart text you quote — **if it appears only in your own rationale, it is your judgment, and the answer is `unknown`**. Where the chart does not supply it, answer `unknown` and let the reviewer judge.

In ordinary clinical usage atopy is the predisposition to IgE-mediated allergic disease, conventionally atopic dermatitis (eczema), allergic rhinitis and allergic asthma. **The protocol does not say this and does not say which of them, or how many, would be "significant".** Record what the chart documents; do not grade it.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `CLINICALLY_SIGNIFICANT_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `MULTIPLE_COUNT_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `SEVERE_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `SIGNIFICANT_ATOPY_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — the chart itself characterizes the atopy as significant or severe (an explicit descriptor such as "severe atopic dermatitis"), or documents anaphylaxis to environmental allergens. Allergist/immunology management or immunotherapy alone is management intensity, not the chart grading severity — record it **prominently** as candidate evidence and answer `unknown`.
- `condition_not_met` — an affirmative statement that there is no atopic history
- `unknown` — not addressed, or atopic disease documented with no severity characterization (eczema, allergic rhinitis or allergic asthma on a problem list) — record the conditions in `rationale`; grading them "significant" is the reviewer's call, and mild atopy is near-ubiquitous in this population
**Asthma alone is not automatically atopy** — asthma has non-allergic phenotypes. Cite the allergic descriptor if present; if the chart says only "asthma" with no allergic qualifier, answer `unknown` and say so in `rationale`.
Search terms: atopy, atopic, eczema, atopic dermatitis, allergic rhinitis, hay fever, environmental allergies, aeroallergen, IgE, RAST, skin prick.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
