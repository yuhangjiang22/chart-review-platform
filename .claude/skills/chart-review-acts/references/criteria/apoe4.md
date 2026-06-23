---
field_id: apoe4
prompt: Is an APOE ε4 allele present?
answer_schema:
  enum:
    - "1"
    - "0"
    - "NA"
cardinality: one
group: genotype
derivation: 'apoe_genotype in ["e2/e4","e3/e4","e4/e4","e4_carrier"] ? "1" : apoe_genotype in ["e2/e2","e2/e3","e3/e3"] ? "0" : "NA"'
---

# Criterion: apoe4 (computed)

## Definition

Whether the patient's documented APOE genotype includes at least one **ε4**
allele (the principal Alzheimer's risk allele). This field is **computed** —
not extracted directly — from `apoe_genotype`:

- **`1`** — ε4 present: `e2/e4`, `e3/e4`, `e4/e4`, or `e4_carrier`.
- **`0`** — a full genotype rules ε4 out: `e2/e2`, `e2/e3`, `e3/e3`.
- **`NA`** — `none` (no genotype), or a carrier of a different allele
  (`e2_carrier` / `e3_carrier`) where ε4's presence can't be established.

## Extraction guidance

Do not answer this field directly — it is auto-derived from `apoe_genotype` and
shown on the **Computed** panel. To change it, fix `apoe_genotype`; this value
recomputes. Confirm the computed value during validation.
