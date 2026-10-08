---
field_id: aacv_inc_002_a3
prompt: Was the participant assigned male at birth?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: demographics
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [sex_assigned_at_birth]
---
# Criterion: Sex assigned at birth — male
## Definition
AACV inclusion [2], p.39: *"…or Are individuals assigned male at birth (males)."*
This is the second limb of the disjunction: a participant assigned male at birth satisfies criterion [2] outright — the childbearing-potential question does not arise.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `CROSS_REFERENCED_DEFINITION_NOT_EXPANDED_AS_ATOMS` (Manual review) — Review against the cited protocol text and document the adjudication.
- `LOCAL_CONTRACEPTION_REQUIREMENT_DEPENDS_ON_JURISDICTION` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SHOULD_NORMATIVE_FORCE_UNCLEAR` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `DO_NOT_AUTOMATE_CONTRACEPTION_SHOULD_CLAUSE` (Manual review) — Review against the cited protocol text and document the adjudication.
- `CONTRACEPTION_CLAUSE_RETAINED_AS_NON_PASS_FAIL_SOURCE_TEXT` (Manual review) — Review against the cited protocol text and document the adjudication.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — sex assigned at birth documented as male, **or** established by sex-specific evidence such as prostate findings or orchiectomy
- `condition_not_met` — documented as female, or established by sex-specific evidence such as hysterectomy, oophorectomy, or an obstetric history
- `unknown` — not documented, or only a current gender identity is recorded with no statement of sex assigned at birth
Sex assigned at birth is not gender identity. Protocol Sec 10.4.1 notes that individuals AFAB receiving hormone therapy for gender transition remain AFAB for this purpose; the same care applies here. If the chart records only gender identity, answer `unknown`.
Prefer the structured demographic record; a note is corroboration. Most charts carry only an administrative or legal sex field. Use it as the
evidence when nothing in the chart suggests it differs from sex assigned at
birth; where gender-affirming care or a transgender history is documented and no
explicit birth-sex field exists, answer `unknown`.
## Examples
- Demographic record: sex assigned at birth = M → `condition_met`
- Only a legal/administrative sex field = M, and nothing in the chart suggests it
  differs from sex assigned at birth → `condition_met`, naming the field used
- Legal sex = M, gender-affirming hormone therapy documented, no explicit
  birth-sex field → `unknown`
- Demographic record: sex assigned at birth = F → `condition_not_met`
- Notes use male pronouns throughout, no demographic record retrieved → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
