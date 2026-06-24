---
field_id: allergen
prompt: What substance(s) is the patient documented to be allergic / hypersensitive / intolerant to?
answer_schema:
  type: string
cardinality: one
group: allergy
---

# Criterion: allergen

The patient's documented **allergen substance(s)** — the things the patient
reacts to, recorded as one free-text value. List the verbatim substance terms;
separate multiple with `; ` (e.g. "penicillin; shellfish"). Use `none` when the
note documents NKDA / "no known allergies" / "denies allergies" or no allergen at
all.

Capture the SUBSTANCE only (not the reaction): "allergic to penicillin (rash)" →
`penicillin`. Class/group allergens are valid (`sulfa drugs`, `NSAIDs`, `tree
nuts`). Include resolved/inactive allergies. **Exclude:** family history ("mother
allergic to…"), refuted / entered-in-error, suspected / "rule out", allergy-panel
orders, plain reaction words (`rash`, `hives`), and side-effects not labeled as an
allergy. (Per the ACTS Allergy guideline.)

**Evidence:** cite the allergy span (or the NKDA statement for `none`).
