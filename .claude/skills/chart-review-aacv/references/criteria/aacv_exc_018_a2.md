---
field_id: aacv_exc_018_a2
prompt: Does the chart document a current **serious** illness?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: general_health
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [serious_unstable_illness]
---
# Criterion: Current serious illness
## Definition
AACV exclusion [18], p.41, verbatim: *"Have a disease or condition that, in the investigator's opinion, could interfere with this study or is a current serious or unstable illness, including"* — followed by the protocol's own list: *"cardiovascular / hepatic / renal / gastroenterologic / respiratory / endocrinologic / neurologic (other than the studied condition) / psychiatric / immunologic, or / hematologic."*

This atom covers the **serious** limb only; **unstable** is `aacv_exc_018_a3`.

> **Not defined in the protocol.** The protocol gives no definition, threshold or instrument for "serious". Anything below is ordinary clinical usage, written so the extractor knows what text to look for — it is **not** a protocol standard. The deciding evidence must always be the chart's **own** characterization; the material below only shows what that characterization typically looks like. Concretely: the qualifying word must appear in the chart text you quote — **if it appears only in your own rationale, it is your judgment, and the answer is `unknown`**. Where the chart does not supply it, answer `unknown` and let the reviewer judge.

The list above is the protocol's list of body systems, not a list of qualifying illnesses. Note the protocol's own carve-out on the neurologic line: *"other than the studied condition"* — DLB itself does not satisfy this atom.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `INVESTIGATOR_OPINION_SCOPE_AMBIGUOUS` — recorded on this atom.
- `INVESTIGATOR_OPINION_SCOPE_AMBIGUOUS` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- `NONEXHAUSTIVE_EXAMPLE_LIST_NOT_MODELED_AS_CLOSED_OR` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SERIOUS_AND_UNSTABLE_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — a current serious condition documented: end-stage or decompensated organ disease, active malignancy, a condition requiring ongoing hospital-level care
- `condition_not_met` — an affirmative statement that the patient's chronic conditions are stable and none is serious
- `unknown` — not addressed, or only a bare diagnosis list with no severity information
**A chronic diagnosis alone is not a serious illness.** Cite the severity language (decompensated, end-stage, active, uncontrolled), not the diagnosis name.
Anchor to the index date; prefer the most recent documentation.

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
