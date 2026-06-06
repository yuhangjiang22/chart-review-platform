---
field_id: labile_inr
prompt: Is the patient's INR labile (Time in Therapeutic Range < 60% over the prior 6 months)?
answer_schema:
  type: enum
  enum: ["yes", "no", "not_applicable"]
is_final_output: false
time_window: lookback_6mo
is_applicable_when: 'true'
---

## Definition

The HAS-BLED L component scores 1 point if the patient's
Time-in-Therapeutic-Range (TTR) over the recent treatment period is
below 60%. TTR is computed as the proportion of days in the last 6
months during which the INR was within the target range (typically
2.0–3.0 for AFib).

`not_applicable` if the patient is NOT on warfarin (DOAC users have no
INR to monitor; HAS-BLED L doesn't apply). Per recent guidance, the
score is sometimes applied with L=0 for DOAC users; this rubric uses
`not_applicable` to make that distinction explicit.

## Extraction guidance

- Search the medication list within 6 months for warfarin (Coumadin)
- If on warfarin: pull all INR values in the 6-month window, compute TTR
  via Rosendaal linear interpolation
- If on DOAC (apixaban, rivaroxaban, dabigatran, edoxaban) and NOT on
  warfarin → "not_applicable"
- If anticoagulant therapy is undocumented or unclear, escalate

## Examples

**Satisfying ("yes"):**
- 6-month INR series: 1.5, 1.8, 3.5, 4.0, 2.1, 1.4 — TTR ≈ 35% → yes

**Non-satisfying ("no"):**
- 6-month INR series tightly grouped 2.1–2.8 — TTR ≈ 90% → no

**Not applicable:**
- Patient on apixaban only — no INR monitoring → not_applicable

## Boundary / failure modes

- Warfarin started < 6 months ago: use the available data; if < 6 weeks
  of data, escalate (TTR isn't reliable from < 6 weeks of values)
- Patient briefly switched to LMWH bridge — exclude bridging days from
  the TTR denominator
- TTR exactly 60% → "no" (the cutoff is < 60%, strict)
