---
field_id: onset_latency_days
prompt: For Item 1, how many days is the latency (drug start→injury for path A; drug stop→injury for path B)?
answer_schema:
  type: integer
  minimum: 0
  maximum: 3650
cardinality: one
group: rucam
role: intermediate
---

# Criterion: onset_latency_days

## Definition

The Item 1 **latency** in days:
- path A (`initial_treatment` / `re_exposure`): days from the episode START to T0.
- path B (`from_cessation`): days from the drug STOP to T0.

## Extraction guidance

Use the episode day offsets from `get_drug_episodes` (`start_day` / `end_day`
relative to T0). Path A latency = `-start_day`; path B latency = `-end_day`.
Reconcile with note-documented start/stop dates if they clearly differ. If
`onset_path` is `not_calculable`, record `0` (the value is unused — Item 1 scores 0).
