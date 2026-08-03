---
field_id: t1d_insulin_preceded_t2d
prompt: Did insulin use precede the first T2D coding?
answer_schema:
  enum: [yes, no]
cardinality: one
group: longitudinal
derivation: 'days_between(earliest_t2d_date, first_insulin_date) > 0 ? "yes" : "no"'
---

# Criterion: t1d_insulin_preceded_t2d (computed)

## Definition

Longitudinal flag: whether **insulin use began before the first T2D coding** —
`met` (`yes`) when `first_insulin_date` is earlier than `earliest_t2d_date`. A T1D
course typically shows insulin (and T1D framing) preceding any later T2D codes.
**Computed** from the two dates — do not answer directly. Renders Pending until
both dates are known.
