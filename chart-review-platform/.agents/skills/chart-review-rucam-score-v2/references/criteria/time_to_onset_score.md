---
field_id: time_to_onset_score
prompt: What RUCAM time-to-onset score does the interval between drug start and liver injury onset earn (hepatocellular pattern)?
answer_schema:
  type: integer
  minimum: -3
  maximum: 2
is_final_output: false
time_window: peri_drug
---

## Definition

RUCAM's component 1 awards points based on how plausibly the timing of
liver-enzyme onset relative to drug exposure points to the suspect drug
(hepatocellular table per Danan & Teschke 2016):

| Initial drug exposure timing | Subsequent drug exposure timing | Score |
|---|---|---|
| 5–90 days from start | 1–15 days from start (rechallenge) | +2 |
| <5 or >90 days from start | >15 days from start | +1 |
| ≤15 days after stopping | ≤15 days after stopping | +1 |
| >15 days after stopping | >15 days after stopping | 0 |
| Incompatible (e.g. injury before drug) | — | −3 |

If timing is documented but doesn't fit any row above, score 0 with a
rationale note.

## Extraction guidance

- Drug-start date: the index_anchor value.
- Injury-onset date: the date of the first abnormal ALT (≥3× ULN for
  hepatocellular).
- If the patient has had this drug before (rechallenge / re-exposure), use
  the "subsequent exposure" column.
- Rounding: include both endpoints (5 days from start = +2, 90 days = +2).

## Examples

- Drug started day 0, ALT first elevated on day 14 → +2
- Drug started day 0, ALT first elevated on day 100 → +1
- Drug stopped on day 30, ALT first elevated on day 40 (i.e. 10 days post-stop) → +1
- Drug stopped on day 30, ALT first elevated on day 60 (i.e. 30 days post-stop) → 0
- ALT abnormal on day −5 (before drug start) → −3

## Boundary / failure modes

- If both initial and subsequent exposure could apply (patient was on the
  drug, stopped, restarted), use the most recent exposure window that
  contains the injury onset.
- If onset date is documented only as "within the past month" with no
  precise date, assume midpoint and score conservatively.
