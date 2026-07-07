---
field_id: injury_track
prompt: What is the injury type (track) from the R ratio — hepatocellular, cholestatic, or mixed?
answer_schema:
  enum: [hepatocellular, cholestatic, mixed]
cardinality: one
group: rucam
role: intermediate
required_note: "Computed from the R ratio via compute_r_ratio; several items key their scoring thresholds on the track."
---

# Criterion: injury_track

## Definition

The DILI **injury type (track)**, set from the R ratio (ALT/ULN ÷ ALP/ULN):
`R > 5` → **hepatocellular**, `R < 2` → **cholestatic**, `2 ≤ R ≤ 5` → **mixed**.
Cholestatic and mixed share the same scoring thresholds; hepatocellular differs.
Several RUCAM items (1, 2, 3) key their scoring on this track.

## Extraction guidance

Call `compute_r_ratio` and record the returned track — do not eyeball it from raw
labs. Cite the peak ALT/ALP values (or the tool's structured result) as evidence.
