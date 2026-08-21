---
field_id: decompensated_365d
prompt: Any hepatic decompensation within 365 days of index? (computed)
answer_schema:
  enum: [yes, no]
cardinality: one
group: computed
derivation: 'ascites_365d != "none" OR ohe_365d != "none" OR variceal_bleed_365d != "none" OR phg_bleed_365d != "none" ? "yes" : "no"'
---

# Computed: decompensated_365d

**Computed - do not answer directly.** `yes` when ANY graded decompensation
event (ascites, overt HE, variceal hemorrhage, PHG bleeding) is present within
the 365-day lookback at ANY tier (definite / highly_likely / probable).

v0.1 DECISION (clinician-adjustable): all three tiers count as decompensation.
If the study later restricts to definite/highly_likely, only this derivation
changes - the graded leaves stay as extracted.
