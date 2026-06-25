---
field_id: apoe3
prompt: Is an APOE ε3 allele present?
answer_schema:
  enum:
    - "1"
    - "0"
    - "NA"
cardinality: one
group: genotype
derivation: 'apoe_genotype in ["e2/e3","e3/e3","e3/e4","e3_carrier"] ? "1" : apoe_genotype in ["e2/e2","e2/e4","e4/e4"] ? "0" : "NA"'
---

# Criterion: apoe3 (computed)

## Definition

Whether the patient's documented APOE genotype includes at least one **ε3**
allele. This field is **computed** — not extracted directly — from
`apoe_genotype`:

- **`1`** — ε3 present: `e2/e3`, `e3/e3`, `e3/e4`, or `e3_carrier`.
- **`0`** — a full genotype rules ε3 out: `e2/e2`, `e2/e4`, `e4/e4`.
- **`NA`** — `none` (no genotype), or a carrier of a different allele
  (`e2_carrier` / `e4_carrier`) where ε3's presence can't be established.

## Extraction guidance

Do not answer this field directly — it is auto-derived from `apoe_genotype` and
shown on the **Computed** panel. To change it, fix `apoe_genotype`; this value
recomputes. Confirm the computed value during validation.

## Examples

- `apoe_genotype = e3/e4` → `1` (ε3 present)
- `apoe_genotype = e2/e4` → `0` (full genotype, no ε3)
- `apoe_genotype = e2_carrier` → `NA` (different-allele carrier; ε3 cannot be established)
- `apoe_genotype = none` → `NA` (no genotype documented)
