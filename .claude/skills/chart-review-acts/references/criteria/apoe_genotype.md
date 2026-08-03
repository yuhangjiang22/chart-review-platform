---
field_id: apoe_genotype
prompt: What APOE genotype is documented for this patient (from APOE genetic testing)?
answer_schema:
  enum:
    - "e2/e2"
    - "e2/e3"
    - "e2/e4"
    - "e3/e3"
    - "e3/e4"
    - "e4/e4"
    - "e2_carrier"
    - "e3_carrier"
    - "e4_carrier"
    - "none"
cardinality: one
group: genotype
required: false
role: intermediate
required_note: "NECESSARY — sole input that derives the required apoe2/apoe3/apoe4 outputs; not itself a guideline output."
---

# Criterion: apoe_genotype (the extracted APOE source)

## Definition

The patient's **documented** APOE genotype. This is the single field you extract
for APOE; the three allele flags `apoe2`, `apoe3`, `apoe4` are **computed** from
it (see those criteria). Use only **explicitly documented APOE genotype / genetic
testing** — never infer from an AD diagnosis, cognitive impairment, family
history, or risk statements.

Every individual carries exactly two APOE alleles (each ε2, ε3, or ε4), giving
six full genotypes. When only one allele is documented (a "carrier" statement),
the genotype is partial. When nothing is documented, it is `none`.

## Allowed values

**Full genotypes** (both alleles documented):
- `e2/e2`, `e2/e3`, `e2/e4`, `e3/e3`, `e3/e4`, `e4/e4`

**Single-allele carrier** (one allele documented, the other unspecified — e.g.
"heterozygous ε4 carrier", "APOE4 positive", "ε2 carrier"):
- `e2_carrier`, `e3_carrier`, `e4_carrier`

**No genotype documented:**
- `none`

## Extraction guidance

- Read the documented APOE genotype / carrier status from genetic testing,
  neurology / genetics / AD-clinic notes, labs, or the problem list. Recognize
  APOE / ApoE / Apolipoprotein E, and ε2/ε3/ε4 = e2/e3/e4 = E2/E3/E4 = "type 4"
  = "allele 4". Separators are equivalent: `ε3/ε4`, `e3e4`, `3/4`, `3,4`.
- **Full two-allele genotype** ("ε3/ε4", "APOE ε4/ε4", "homozygous ε4" = e4/e4) →
  the matching `eX/eY` value. Order the alleles ε2 < ε3 < ε4 (always `e3/e4`,
  never `e4/e3`).
- **Single-allele carrier** with the second allele unspecified ("APOE4 carrier",
  "ε4 positive", "heterozygous for ε4") → `e4_carrier` (and likewise `e2_carrier`
  / `e3_carrier`). "homozygous ε4" is the FULL genotype `e4/e4`, not a carrier.
- **No APOE genotype / testing documented** → `none`. Also `none` when the only
  APOE mention is family history, an AD-risk statement, a planned/ordered test,
  or a serum **apolipoprotein E protein level** (e.g. "ApoE 4.2 mg/dL" — a lab
  value with units, NOT a genotype).
- **Evidence:** cite the verbatim genotype / carrier span. For `none`, cite the
  section checked (genetics/labs) or note that no genotype is documented.

## Examples

- "APOE genotype: ε3/ε4" → `e3/e4`
- "APOE result: e2/e3" → `e2/e3`
- "Genotyping demonstrated APOE ε4/ε4." → `e4/e4`
- "Patient is a heterozygous APOE4 carrier." → `e4_carrier`
- "APOE ε4 positive" → `e4_carrier`
- "Mother carries APOE4." (family history only) → `none`
- No APOE testing documented → `none`
