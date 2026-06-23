---
field_id: apoe3
prompt: Is an APOE ε3 allele documented for this patient (from APOE genotype testing)?
answer_schema:
  enum:
    - "1"
    - "0"
    - "NA"
cardinality: one
group: genotype
---

# Criterion: apoe3

## Definition

Whether the patient's documented APOE genotype includes at least one **ε3**
allele. Use only **explicitly documented APOE genotype / genetic testing**
results — never infer from diagnosis, cognition, family history, or risk.

Three values:
- **`1`** — at least one ε3 allele present (ε2/ε3, ε3/ε3, or ε3/ε4).
- **`0`** — a documented genotype rules ε3 out (ε2/ε2, ε2/ε4, ε4/ε4).
- **`NA`** — no APOE genotype documented, or only partial info that doesn't
  establish ε3's presence/absence.

> If no genotype is documented, all three APOE labels are **`NA`** (never 0/0/0).

## Extraction guidance

- Read the documented APOE genotype from genetic testing / neurology / genetics /
  lab / problem-list sources. Recognize APOE / ApoE / Apolipoprotein E and
  ε3 / e3 / E3 spellings.
- Map: ε3 present in ε2/ε3, ε3/ε3, ε3/ε4 → `1`; absent in ε2/ε2, ε2/ε4, ε4/ε4 → `0`.
- An ε4-only statement without the full genotype does not establish ε3 → `NA`.

**Evidence:** cite the documented genotype span. For `NA`, cite the checked
section or note no genotype documented.

## Examples

- "APOE genotype: ε3/ε4" → `1`
- "APOE e3/e3" → `1`
- "APOE ε2/ε4" → `0`
- "APOE ε4/ε4" → `0`
- "Heterozygous APOE4 carrier" (no full genotype) → `NA`
- No APOE testing documented → `NA`
