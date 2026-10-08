---
field_id: aacv_inc_002_a1
prompt: Was the participant assigned female at birth?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: demographics
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [sex_assigned_at_birth]
---

# Criterion: Sex assigned at birth — female

## Definition

AACV inclusion criterion [2], protocol p.39: *"Are individuals assigned female
at birth (females) who are not of childbearing potential, or / Are individuals
assigned male at birth (males)."*

This atom answers only the first half of the disjunction: **was this participant
assigned female at birth**. It exists mainly as the antecedent for
`aacv_inc_002_a2`, which applies only to participants who were.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `CROSS_REFERENCED_DEFINITION_NOT_EXPANDED_AS_ATOMS` (Manual review) — Review against the cited protocol text and document the adjudication.
- `LOCAL_CONTRACEPTION_REQUIREMENT_DEPENDS_ON_JURISDICTION` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SHOULD_NORMATIVE_FORCE_UNCLEAR` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `DO_NOT_AUTOMATE_CONTRACEPTION_SHOULD_CLAUSE` (Manual review) — Review against the cited protocol text and document the adjudication.
- `CONTRACEPTION_CLAUSE_RETAINED_AS_NON_PASS_FAIL_SOURCE_TEXT` (Manual review) — Review against the cited protocol text and document the adjudication.
- Analyst note from the workbook: "Non-pass/fail source clause retained for manual review only: 'Contraceptive use by participants should be consistent with local regulations ...'. It is excluded from automated eligibility logic because applicability and normative force are unresolved."
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `condition_met` — sex assigned at birth is documented as female, **or** the chart documents sex-specific anatomy or procedures that establish it: hysterectomy, oophorectomy, a pregnancy or obstetric history
- `condition_not_met` — documented as male, or established by sex-specific evidence such as prostate findings or orchiectomy
- `unknown` — not documented, or documented only as a current gender identity
  with no statement about sex assigned at birth

**Sex assigned at birth is not gender identity.** The protocol's own definitions
(Section 10.4.1, p.104) note that individuals AFAB receiving hormone therapy as
part of gender transition are still treated as AFAB for this purpose. If the
chart records a gender identity but not sex assigned at birth, answer `unknown`
rather than inferring one from the other.

Prefer the structured demographic record. A note stating sex is corroboration,
not the primary source. Most charts carry only an administrative or legal sex field. Use it as the
evidence when nothing in the chart suggests it differs from sex assigned at
birth; where gender-affirming care or a transgender history is documented and no
explicit birth-sex field exists, answer `unknown`.

## Examples

- Demographic record: sex assigned at birth = F → `condition_met`
- Only a legal/administrative sex field = F, and nothing in the chart suggests it
  differs from sex assigned at birth → `condition_met`, naming the field used
- Legal sex = F, gender-affirming hormone therapy documented, no explicit
  birth-sex field → `unknown`
- Demographic record: sex assigned at birth = M → `condition_not_met`
- Notes refer to the patient as "she" throughout, no demographic record
  retrieved → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
