---
field_id: gt50_t1d
prompt: Are more than 50% of the diabetes-type codes type 1?
answer_schema:
  enum: [yes, no]
cardinality: one
group: dicaya
derivation: 't1d_code_count > t2d_code_count ? "yes" : "no"'
---

# Criterion: gt50_t1d (computed)

## Definition

Whether **more than 50%** of the patient's diabetes-type codes are T1D — true
exactly when `t1d_code_count > t2d_code_count` (equivalent to a proportion > 0.5,
and null-safe: it needs no division). `no` when there are no diabetes codes.
**Computed — do not answer directly.** Feeds Klompas criteria 1 and 2.
