---
field_id: apoe4
prompt: Is an APOE ε4 allele documented for this patient (from APOE genotype testing)?
answer_schema:
  enum:
    - "1"
    - "0"
    - "NA"
cardinality: one
group: genotype
---

# Criterion: apoe4

## Definition

Whether the patient's documented APOE genotype includes at least one **ε4**
allele (the principal Alzheimer's risk allele). Use only **explicitly documented
APOE genotype / genetic testing** — never infer from an AD diagnosis, cognitive
impairment, family history, or risk statements.

Three values:
- **`1`** — at least one ε4 allele present (ε2/ε4, ε3/ε4, or ε4/ε4), or an
  explicit ε4-carrier statement ("APOE4 carrier", "ε4 positive", "heterozygous/
  homozygous for ε4").
- **`0`** — a documented genotype rules ε4 out (ε2/ε2, ε2/ε3, ε3/ε3).
- **`NA`** — no APOE genotype documented, or only partial info that doesn't
  establish ε4's presence/absence.

> If no genotype is documented, all three APOE labels are **`NA`** (never 0/0/0).

## Extraction guidance

- Read the documented APOE genotype / ε4 carrier status from genetic testing,
  neurology / genetics / AD-clinic notes, labs, or problem list. Recognize APOE /
  ApoE / Apolipoprotein E and ε4 / e4 / E4 spellings.
- Map: ε4 present in ε2/ε4, ε3/ε4, ε4/ε4 → `1`; absent in ε2/ε2, ε2/ε3, ε3/ε3 → `0`.
- Unlike ε2/ε3, an explicit **ε4 carrier / ε4 positive** statement is sufficient
  for `1` even without the full two-allele genotype.

**Evidence:** cite the genotype span or the explicit ε4-carrier statement. For
`NA`, cite the checked section or note no genotype documented.

## Examples

- "APOE genotype: ε3/ε4" → `1`
- "Patient is heterozygous APOE4 carrier." → `1`
- "APOE ε4 positive" → `1`
- "APOE ε4/ε4" → `1`
- "APOE e2/e3" → `0`
- "APOE ε3/ε3" → `0`
- No APOE testing documented → `NA`
