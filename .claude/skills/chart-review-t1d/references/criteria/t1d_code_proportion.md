---
field_id: t1d_code_proportion
prompt: What proportion of diabetes-type codes are type 1?
answer_schema:
  type: number
cardinality: one
group: dicaya
derivation: 't1d_code_count / (t1d_code_count + t2d_code_count)'
---

# Criterion: t1d_code_proportion (computed)

## Definition

The DiCAYA diagnosis-code proportion: `t1d_code_count / (t1d_code_count +
t2d_code_count)`, a fraction in **0–1**. **Computed — do not answer directly.**
When no diabetes codes are documented (denominator 0) the value is undefined and
renders as Pending. `> 0.5` supports, but does not confirm, T1D.

To change it, fix `t1d_code_count` or `t2d_code_count`.
