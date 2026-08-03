---
field_id: allergen
prompt: What substance(s) is the patient documented to be allergic / hypersensitive / intolerant to?
answer_schema:
  type: array
  entity:
    value_key: Allergen
    required: [Allergen, Supporting_Evidence]
    attributes:
      Category: { enum: [medication, food, environment, biologic] }
      Type: { enum: [allergy, intolerance] }
      Reaction: {}
      Severity: { enum: [mild, moderate, severe] }
      Clinical_Status: { enum: [active, inactive, resolved] }
      Verification_Status: { enum: [confirmed, unconfirmed, refuted, entered-in-error] }
cardinality: one
group: allergy
---

# Criterion: allergen

## Definition

The patient's documented **allergen substance(s)** — the specific
substance(s) the patient is **allergic, hypersensitive, or intolerant to** —
recorded as a JSON **list of allergen entity records**, one record per
substance. Emit `[]` when the note documents NKDA / "no known allergies" /
"denies allergies" or no patient allergen at all.

Each record is an object:

```
{
  "Allergen": <verbatim substance term>,
  "Supporting_Evidence": <verbatim snippet from the note>,
  "Category": <medication | food | environment | biologic>,   // optional
  "Type": <allergy | intolerance>,                            // optional
  "Reaction": <verbatim reaction text>,                       // optional
  "Severity": <mild | moderate | severe>,                     // optional
  "Clinical_Status": <active | inactive | resolved>,          // optional
  "Verification_Status": <confirmed | unconfirmed | refuted | entered-in-error>  // optional
}
```

`Allergen` and `Supporting_Evidence` are **required** on every record; the
remaining attributes are optional — include each only when the note documents
it. Allergens span four categories: **medication/drug**, **food**,
**environment**, and **biologic**. Use only what is documented about the
patient — do not infer. (Per the ACTS Allergy Extraction guideline.)

## Extraction guidance

The `Allergen` value is the **SUBSTANCE only — never the reaction**. In
"allergic to penicillin (rash)" the `Allergen` is `penicillin` and the reaction
`rash` goes in the optional `Reaction` attribute — it is never the allergen.

- **One record per substance.** "Allergies: penicillin, sulfa, shellfish" →
  three records (`penicillin`, `sulfa`, `shellfish`).
- **Class / group allergens are valid** when that is how the note states it:
  `sulfa drugs`, `NSAIDs`, `cephalosporins`, `tree nuts`, `dairy`.
- **Extract the substance verbatim** (brand or generic, e.g. `Augmentin`);
  normalization happens downstream.
- **Include resolved / inactive allergies** — the reaction was real and remains
  in the patient's allergy history. Record `Clinical_Status: resolved` (or
  `inactive`) on the record; do not drop it.

**Do NOT emit a record for** (→ contributes nothing; emit `[]` if it is the
only mention):
- **Family history** ("mother allergic to penicillin", "FH of food allergies") —
  the allergy belongs to a relative, not the patient.
- **Refuted / entered-in-error** ("penicillin allergy refuted on rechallenge",
  "allergy entry made in error") — the allergy is negated.
- **Suspected / unconfirmed** ("possible sulfa allergy", "rule out penicillin
  allergy", "may be allergic to…").
- **Allergy-evaluation orders** ("allergy panel ordered", "referred for skin
  testing") — no allergen confirmed.
- **Side effects not labeled as an allergy** ("nausea from metformin (side
  effect)") unless the clinician documents it as an allergy / hypersensitivity /
  intolerance.
- **Bare reaction words** (`rash`, `hives`, `anaphylaxis`, `swelling`) — these
  are manifestations, never the allergen.

**Evidence:** each record's `Supporting_Evidence` is the verbatim allergy span
naming the substance. Never cite a family-history or refuted sentence to
support an allergen record.

## Examples

- "Allergic to penicillin (rash)." →
  `[{"Allergen":"penicillin","Reaction":"rash","Type":"allergy","Clinical_Status":"active","Supporting_Evidence":"Allergic to penicillin (rash)."}]`
- "Allergies: penicillin, sulfa, shellfish" →
  `[{"Allergen":"penicillin","Supporting_Evidence":"Allergies: penicillin, sulfa, shellfish"},{"Allergen":"sulfa","Supporting_Evidence":"Allergies: penicillin, sulfa, shellfish"},{"Allergen":"shellfish","Supporting_Evidence":"Allergies: penicillin, sulfa, shellfish"}]`
- "Penicillin allergy, resolved." →
  `[{"Allergen":"penicillin","Clinical_Status":"resolved","Supporting_Evidence":"Penicillin allergy, resolved."}]` (resolved still extracted)
- "NKDA." / "Denies allergies." → `[]`  (no documented allergen)
- "Mother allergic to penicillin." → `[]`  (family history, excluded)
- "Penicillin allergy refuted on testing." → `[]`  (refuted/negated)
- "Allergy panel ordered." → `[]`  (evaluation only)
