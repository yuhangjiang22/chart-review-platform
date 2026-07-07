---
field_id: concomitant_worst_timing
prompt: For Item 4, among concomitant drugs, what is the worst-case timing relative to the injury?
answer_schema:
  enum: [suggestive, compatible, incompatible, none]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: concomitant_worst_timing

## Definition

The timing of the concomitant (non-suspect) drug that is the **strongest** alternative
explanation:
- `suggestive` — ongoing at T0 within the suggestive window (5–90d initial / 1–15d
  re-exposure for hepatocellular; 5–90d / 1–90d for cholestatic-mixed).
- `compatible` — ongoing at T0 outside the suggestive window, or stopped within the
  carry-over window.
- `incompatible` — stopped well before T0, started after T0, or timing indeterminate.
- `none` — no concomitant drugs.

## Extraction guidance

`get_medications(in_90day_window=True)` (exclude the suspect drug) + note search for
OTC/herbals; `get_drug_episodes` for each; classify each drug's timing per
`references/scoring/item-4-concomitant.md`; record the worst-case.
