---
field_id: aacv_exc_018_a3
prompt: Does the chart document a current **unstable** illness?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: general_health
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [serious_unstable_illness]
---
# Criterion: Current unstable illness
## Definition
AACV exclusion [18], p.41, the **unstable** limb of *"is a current serious or unstable illness"*. Same body-system list as `aacv_exc_018_a2`, including the protocol's *"other than the studied condition"* carve-out on the neurologic line.

> **Not defined in the protocol.** The protocol gives no definition, threshold or instrument for "unstable". Anything below is ordinary clinical usage, written so the extractor knows what text to look for — it is **not** a protocol standard. The deciding evidence must always be the chart's **own** characterization; the material below only shows what that characterization typically looks like. Concretely: the qualifying word must appear in the chart text you quote — **if it appears only in your own rationale, it is your judgment, and the answer is `unknown`**. Where the chart does not supply it, answer `unknown` and let the reviewer judge.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `INVESTIGATOR_OPINION_SCOPE_AMBIGUOUS` — recorded on this atom.
- `INVESTIGATOR_OPINION_SCOPE_AMBIGUOUS` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- `NONEXHAUSTIVE_EXAMPLE_LIST_NOT_MODELED_AS_CLOSED_OR` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SERIOUS_AND_UNSTABLE_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — instability documented: decompensation, an acute exacerbation, a recent admission for the condition, "uncontrolled", "acute on chronic", a recent significant treatment change for deterioration
- `condition_not_met` — an affirmative statement that the condition is stable or well controlled
- `unknown` — not addressed
**Stability is a statement about trajectory, not about diagnosis.** Cite the trajectory language.
Search terms: unstable, decompensated, exacerbation, uncontrolled, acute on chronic, flare, admitted for, worsening.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
