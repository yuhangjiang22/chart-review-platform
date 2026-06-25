---
field_id: vaccine_name
prompt: What vaccine(s) is the patient documented to have received / been administered / completed?
answer_schema:
  type: array
  entity:
    value_key: Vaccine_Name
    required: [Vaccine_Name, Supporting_Evidence]
    attributes:
      Category: { enum: [Live Vaccine, Non-Live Vaccine, BCG, Active Amyloid or Tau Immunization, Not a vaccine, Ambiguous] }
      Administration_Date: {}
cardinality: one
group: vaccine
---

# Criterion: vaccine_name

## Definition

The patient's documented **vaccine(s)** — any vaccine documented as
**administered, received, completed, or recorded as active** in the patient's
vaccination history — recorded as a JSON **list of vaccine entity records**,
one record per vaccine. Emit `[]` when no administered/received vaccine is
documented.

Each record is an object:

```
{
  "Vaccine_Name": <verbatim vaccine name>,
  "Category": <Live Vaccine | Non-Live Vaccine | BCG | Active Amyloid or Tau Immunization | Not a vaccine | Ambiguous>,
  "Administration_Date": <date or expression>,   // optional — omit if not stated
  "Supporting_Evidence": <verbatim snippet from the note>
}
```

`Vaccine_Name` and `Supporting_Evidence` are **required** on every record.
`Category` is assigned per the reference table (see below). `Administration_Date`
is optional — include it only when the note states a date.

## Extraction guidance

Emit a record when the note states the vaccine was given to the patient —
"received influenza vaccine", "COVID-19 booster administered", "MMR vaccine
completed", "vaccination history includes pneumococcal vaccine", "patient
received Shingrix in 2023".

- **One record per vaccine**, the `Vaccine_Name` verbatim. "Patient received
  MMR vaccine in childhood and influenza vaccine in October 2024" → two records
  (`MMR`, `Influenza vaccine`).
- **`Administration_Date`** carries the documented date when stated
  ("in October 2024" → `October 2024`); omit it otherwise.

### Category assignment (per-vaccine attribute)

`Category` is now an **attribute of each vaccine entity**. Assign it
**using the reference tables — do NOT guess from memory**:
`references/CDC_Vaccine_Reference_Table.md` (licensed US vaccines) and
`references/Active_Amyloid_Tau_Immunization_Reference_Table.md` (Alzforum, the
investigational AD immunotherapies).

- **Match precedence: brand → abbreviation → disease; brand wins.** One disease
  can have both a live and a non-live product, so the brand decides — shingles:
  Zostavax = Live vs Shingrix = Non-Live; typhoid: Vivotif = Live vs Typhim Vi =
  Non-Live; chikungunya: Ixchiq = Live vs Vimkunya = Non-Live.
- **Disease-only mention with mixed-category products → `Ambiguous`** (don't
  guess). Assign a category from a disease alone only when every product for that
  disease shares it.
- **BCG → its own `BCG`** category (never `Live Vaccine`), despite being
  biologically a live attenuated organism.
- **Active amyloid/tau immunotherapies** (e.g. AADvac1, ACI-24, UB-311, ABvac40,
  CAD106) → `Active Amyloid or Tau Immunization`, matched by name against the
  Alzforum table; never coerced into Live/Non-Live.
- **Passive monoclonal antibodies** (lecanemab, donanemab, aducanumab,
  nirsevimab/Beyfortus, clesrovimab/Enflonsia, etc.) are **`Not a vaccine`**.

Quick reference (resolve specifics via the table):
- **Live:** MMR, MMRV/ProQuad, varicella/Varivax, Zostavax, LAIV/FluMist,
  yellow fever, rotavirus, oral typhoid/Vivotif, dengue/Dengvaxia, Ebola/Ervebo,
  smallpox-mpox (ACAM2000, Jynneos).
- **Non-Live:** Shingrix, inactivated/recombinant flu, COVID-19, pneumococcal,
  Tdap/Td/DTaP, HepA, HepB, HPV/Gardasil, RSV (Abrysvo/Arexvy), IPV, Hib,
  MenACWY, MenB.

**Do NOT emit a record for** vaccines that are merely:
- **Planned** ("influenza vaccine recommended", "will receive RSV vaccine next
  visit").
- **Declined** ("patient declined influenza vaccination").
- **Contraindicated** ("live vaccines contraindicated").
- **Discussed only / educational** ("discussed shingles vaccine", "reviewed
  vaccine schedule").

If the only vaccine mentions are excluded ones, emit `[]`.

**Evidence:** each record's `Supporting_Evidence` is the verbatim vaccine
administration span.

## Examples

- "Received influenza vaccine." →
  `[{"Vaccine_Name":"Influenza vaccine","Category":"Non-Live Vaccine","Supporting_Evidence":"Received influenza vaccine."}]`
- "Patient received Shingrix in 2023." →
  `[{"Vaccine_Name":"Shingrix","Category":"Non-Live Vaccine","Administration_Date":"2023","Supporting_Evidence":"Patient received Shingrix in 2023."}]`
- "Patient received MMR vaccine in childhood and influenza vaccine in October 2024." →
  `[{"Vaccine_Name":"MMR","Category":"Live Vaccine","Supporting_Evidence":"Patient received MMR vaccine in childhood"},{"Vaccine_Name":"influenza vaccine","Category":"Non-Live Vaccine","Administration_Date":"October 2024","Supporting_Evidence":"influenza vaccine in October 2024"}]`
- "Received shingles vaccine." (disease only, mixed products) →
  `[{"Vaccine_Name":"shingles vaccine","Category":"Ambiguous","Supporting_Evidence":"Received shingles vaccine."}]` (Zostavax=Live vs Shingrix=Non-Live)
- "BCG vaccine documented." →
  `[{"Vaccine_Name":"BCG vaccine","Category":"BCG","Supporting_Evidence":"BCG vaccine documented."}]`
- "Lecanemab infusion." →
  `[{"Vaccine_Name":"Lecanemab","Category":"Not a vaccine","Supporting_Evidence":"Lecanemab infusion."}]` (passive monoclonal antibody)
- "Influenza vaccine recommended." → `[]`  (planned, excluded)
- "Patient declined influenza vaccination." → `[]`  (declined, excluded)
- "Discussed shingles vaccine." → `[]`  (educational discussion only)
