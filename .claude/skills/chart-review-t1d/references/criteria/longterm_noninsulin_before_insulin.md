---
field_id: longterm_noninsulin_before_insulin
prompt: Did the patient have long-term non-insulin diabetes treatment before insulin was initiated?
answer_schema:
  enum: [yes, no, no_info]
cardinality: one
group: longitudinal
---

# Criterion: longterm_noninsulin_before_insulin

## Definition

Whether the medication history shows **sustained non-insulin diabetes treatment
BEFORE insulin was initiated** — the pattern of a type-2 course that later required
insulin. This is step 4 of the ground-truth sequence (→ T2D).

## Extraction guidance

**Always commit one value:**

- **`yes`** — the record clearly shows a prolonged period on non-insulin diabetes
  agents (metformin, sulfonylurea, GLP-1, SGLT2, etc.) that **preceded** any insulin
  start.
- **`no`** — insulin was present from the outset, or there was no meaningful
  non-insulin-before-insulin interval (e.g. immediate insulin at diagnosis, as in
  typical T1D).
- **`no_info`** — the medication timeline is too incomplete to judge.

Compare `first_insulin_date` against the earliest non-insulin diabetes-med date.
Require a *sustained* interval, not a brief overlap. Cite the drug rows/dates.

## Examples

- Metformin 2015–2021, insulin added 2021 → `yes`
- Insulin started at diagnosis, no prior oral agents → `no`
- Fragmentary outside med history → `no_info`
