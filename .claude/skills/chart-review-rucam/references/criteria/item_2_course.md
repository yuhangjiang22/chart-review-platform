---
field_id: item_2_course
prompt: RUCAM Item 2 — course after cessation score (computed)
answer_schema:
  enum: [3, 2, 1, 0, -2]
cardinality: one
group: rucam
role: interpretive
required_note: "COMPUTED from dechallenge_outcome and injury_track — not answered directly."
derivation: '(dechallenge_outcome == "not_stopped" OR dechallenge_outcome == "no_followup") ? 0 : injury_track == "hepatocellular" ? (dechallenge_outcome == "ge50_le8d" ? 3 : dechallenge_outcome == "ge50_le30d" ? 2 : dechallenge_outcome == "ge50_le180d" ? 0 : -2) : ((dechallenge_outcome == "ge50_le8d" OR dechallenge_outcome == "ge50_le30d" OR dechallenge_outcome == "ge50_le180d") ? 2 : dechallenge_outcome == "lt50_with_data" ? 1 : 0)'
---

# Criterion: item_2_course (computed)

## Definition

RUCAM Item 2 (course after stopping), **computed** from `dechallenge_outcome` and
`injury_track` — do NOT answer directly:

- Drug **not stopped** / **no follow-up** → **0** (dechallenge not assessable).
- **Hepatocellular:** ≥50% fall by 8d → **+3**; by 30d → **+2**; ≥50% only after 30d → **0**; <50% (with data) or re-rise → **−2**.
- **Cholestatic/mixed:** any ≥50% fall (within 180d) → **+2**; <50% with data → **+1**; persistence/increase → **0**.

## Extraction guidance

Answer `dechallenge_outcome` (using `get_lab_extremum` for peak/nadir) and
`injury_track`; this score derives from them.
