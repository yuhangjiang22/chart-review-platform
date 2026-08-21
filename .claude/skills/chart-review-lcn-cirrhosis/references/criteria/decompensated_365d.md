---
field_id: decompensated_365d
prompt: Any hepatic decompensation within 365 days of index? (computed)
answer_schema:
  enum: [yes, no]
cardinality: one
group: computed
derivation: 'ascites_365d == "definite" OR ohe_365d == "definite" OR ohe_365d == "highly_likely" OR variceal_bleed_365d == "definite" OR phg_bleed_365d == "definite" ? "yes" : "no"'
---

# Computed: decompensated_365d

**Computed - do not answer directly.** `yes` when a decompensation event in
the 365-day lookback reaches the tier that COUNTS for that complication
(v2 spec, operational definition 6, per the registry NCT05740358):

- **ascites/hydrothorax** - `definite` only
- **overt HE** - `definite` OR `highly_likely`
- **variceal hemorrhage / PHG bleeding** - `definite` only
- **`probable` never counts**, for any complication.

The graded leaves are still extracted at their true tier - a probable event is
recorded as `probable`, it just does not flip this verdict. (Supersedes the
v0.1 any-tier decision; settled by Compensated_CP_v2.)
