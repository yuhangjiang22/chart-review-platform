---
field_id: onset_path
prompt: For Item 1, which onset path applies — initial_treatment, re_exposure, from_cessation, or not_calculable?
answer_schema:
  enum: [initial_treatment, re_exposure, from_cessation, not_calculable]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: onset_path

## Definition

The RUCAM Item 1 onset path, from the suspect drug's merged exposure episodes
(`get_drug_episodes`, `relative_to_t0`):
- `initial_treatment` — episode `ongoing_at_t0`, first/continuous treatment (path A, initial).
- `re_exposure` — episode `ongoing_at_t0` that follows an earlier stopped episode (>45-day gap) (path A, re-exposure).
- `from_cessation` — the relevant episode `stopped_before` T0 (path B, onset-from-cessation).
- `not_calculable` — all episodes `started_after` T0 (reaction predates exposure) → item scores 0.

## Extraction guidance

Call `get_drug_episodes(drug_name=<suspect>)`. Pick the episode containing T0
(`ongoing_at_t0`); else the most recent `stopped_before`. A single `ongoing_at_t0`
episode with `n_fills>1` is initial-treatment continuation, not re-exposure.
