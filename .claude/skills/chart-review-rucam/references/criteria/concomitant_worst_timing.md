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

**Empty structured med data ≠ no concomitants.** If `get_medications` /
`get_drug_episodes` return nothing (or the patient summary shows 0 meds in the window)
but the notes document drugs — medication lists, H&P, discharge summaries, clinician
attribution — extract the concomitant drugs from the **notes** and classify their
timing from the note-documented dates. Report `none` only when you have *positively
confirmed* no concomitant drug exists; never conclude `none` from absent structured
data alone (that under-penalizes Item 4). This matters most for out-of-window suspect
drugs, where the true culprit is often a recent concomitant the structured cohort tables
missed.

**`ongoing_at_t0` is not evidence of `suggestive` timing by itself — it only means
the drug was active on T0, which is true of every chronic daily medication.** Before
answering `suggestive`, read the episode's `start_day` and check it against the
window (−5 to −90 initial / −1 to −15 re-exposure for hepatocellular; −5 to −90 /
−1 to −90 for cholestatic-mixed). **Cite the `start_day` value itself in your
evidence — a citation of only the `relative_to_t0` flag, with no `start_day`, is not
sufficient to support `suggestive`.** A drug started 244 days before T0 is `compatible`
even though it is `ongoing_at_t0`, because 244 falls outside every suggestive window.
