---
field_id: apoe2
prompt: Is an APOE ε2 allele documented for this patient (from APOE genotype testing)?
answer_schema:
  enum:
    - "1"
    - "0"
    - "NA"
cardinality: one
group: genotype
---

# Criterion: apoe2

## Definition

Whether the patient's documented APOE genotype includes at least one **ε2**
allele. Use only **explicitly documented APOE genotype / genetic testing**
results — never infer genotype from an Alzheimer's diagnosis, cognitive
impairment, family history, or risk statements.

Three values:
- **`1`** — at least one ε2 allele is present (genotype ε2/ε2, ε2/ε3, or ε2/ε4).
- **`0`** — a documented genotype rules ε2 out (ε3/ε3, ε3/ε4, ε4/ε4).
- **`NA`** — not determinable: no APOE genotype documented, or only partial
  information that doesn't establish ε2's presence/absence.

> Every individual carries exactly two APOE alleles, so a fully documented
> genotype always yields ≥1 allele = `1`. If no genotype is documented, all three
> APOE labels are **`NA`** (never 0/0/0, which is genotypically impossible).

## Extraction guidance

- Read documented APOE genotype from genetic testing reports, neurology/genetics
  notes, AD-clinic notes, lab results, or a problem list.
- Recognize lexical variants: APOE, ApoE, APO-E, APO E, Apolipoprotein E; "APOE
  genotype/genotyping"; allele spellings ε2 / e2 / E2 / "epsilon 2".
- Map the genotype: ε2 present in ε2/ε2, ε2/ε3, ε2/ε4 → `1`; ε2 absent in ε3/ε3,
  ε3/ε4, ε4/ε4 → `0`.
- A statement about only ε4 status ("APOE4 carrier", "ε4 positive") without the
  full genotype does **not** establish ε2 → `NA` for apoe2 unless the full
  genotype is given.

**Evidence:** cite the documented genotype span (e.g. "APOE genotype: ε3/ε4").
For `NA`, cite the section checked or note that no genotype is documented.

## Examples

- "APOE genotype: ε2/ε3" → `1`
- "Genotyping demonstrated APOE ε2/ε4" → `1`
- "APOE result: e3/e3" → `0`
- "APOE ε4/ε4" → `0`
- "APOE ε4 positive" (no full genotype) → `NA`
- No APOE testing documented → `NA`
