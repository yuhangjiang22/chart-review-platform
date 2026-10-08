---
field_id: aacv_inc_003_a1
prompt: Was the participant between 55 and 85 years old, inclusive, at the time of signing the ICF?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: demographics
polarity: inclusion
eligibility_role: REQUIRED
time_window:
  anchor: icf_signing
  relation: at
uses:
  keyword_sets: [date_of_birth_age]
---

# Criterion: Age at ICF signing

## Definition

AACV inclusion criterion [3], protocol p.39, in full: *"Are from 55 to 85 years
of age, inclusive, at the time of signing the ICF."*

Both bounds are inclusive — the protocol says so. Age is evaluated **at ICF
signing**, not at the time of the note, the referral, or the data extract.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

Compute from date of birth and ICF signing date; do not extract a stated age in
place of the computation unless no date of birth is available.

- `condition_met` — computed age is 55 through 85 inclusive
- `condition_not_met` — computed age is outside that range
- `unknown` — either date is missing

**Pre-screening note.** A candidate has not signed an ICF, so the protocol's
anchor does not exist yet. The patient record supplies an `index_date` — the
date this pre-screen is treated as running on — and that is the anchor to use.
Compute age at the index date, and say in `rationale` that you did. The
substitution is an operational decision, not something the protocol states, so
it is recorded on every answer. If no `index_date` is supplied, answer
`unknown` and say the anchor was missing.

Prefer the structured demographic record for date of birth.

Ages within about a year of either bound deserve a prominent note in
`rationale`: age at the actual ICF signing may differ from age at the index
date, and the bound is evaluated at signing.

## Examples

- DOB 1958-03-02, index date 2026-04-01 → age 68 → `condition_met`
- DOB 1975-01-01, index date 2026-04-01 → age 51 → `condition_not_met`
- DOB 1940-06-30, index date 2026-04-01 → age 85 → `condition_met` (85 is included)
- Date of birth present, no index date available → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*
