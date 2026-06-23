---
field_id: apoe2
prompt: Is an APOE ε2 allele present?
answer_schema:
  enum:
    - "1"
    - "0"
    - "NA"
cardinality: one
group: genotype
derivation: 'apoe_genotype in ["e2/e2","e2/e3","e2/e4","e2_carrier"] ? "1" : apoe_genotype in ["e3/e3","e3/e4","e4/e4"] ? "0" : "NA"'
---

# Criterion: apoe2 (computed)

## Definition

Whether the patient's documented APOE genotype includes at least one **ε2**
allele. This field is **computed** — not extracted directly — from
`apoe_genotype`:

- **`1`** — ε2 present: `e2/e2`, `e2/e3`, `e2/e4`, or `e2_carrier`.
- **`0`** — a full genotype rules ε2 out: `e3/e3`, `e3/e4`, `e4/e4`.
- **`NA`** — `none` (no genotype), or a carrier of a different allele
  (`e3_carrier` / `e4_carrier`) where ε2's presence can't be established.

## Extraction guidance

Do not answer this field directly — it is auto-derived from `apoe_genotype` and
shown on the **Computed** panel. To change it, fix `apoe_genotype`; this value
recomputes. Confirm the computed value during validation.
