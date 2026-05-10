---
field_id: proportion_days_covered_180d
prompt: What is the patient's Proportion of Days Covered (PDC) for statins in the prior 180 days?
answer_schema:
  type: number
  minimum: 0.0
  maximum: 1.0
is_final_output: false
time_window: lookback_180d
is_applicable_when: 'statin_active_at_index == "yes"'
---

## Definition

CMS-standard adherence measure. PDC = (number of days in the 180-day
lookback window during which the patient had statin medication
available, based on pharmacy fill data) / 180. Range 0.0 to 1.0.

Gated on `statin_active_at_index == "yes"` — patients without an active
statin prescription return `not_applicable` (the platform's
`is_applicable_when` evaluator handles this; the agent does not need
to compute PDC for those patients).

## Extraction guidance

- Pull all statin pharmacy fills (any HMG-CoA reductase inhibitor) in
  the 180-day lookback.
- For each fill, supply days = days_supply field (default 30 if
  missing — flag).
- Project supply forward from each fill date. If two fills overlap
  (e.g. patient refilled 10 days early), don't double-count the
  overlap days.
- PDC = covered_days / 180. Round to 2 decimals.
- Switching between statins (e.g. atorvastatin → rosuvastatin) counts
  as continuous coverage if no gap.

## Examples

- Three 60-day fills exactly at days 0, 60, 120 (within 180 lookback) →
  180 covered / 180 = 1.00
- One 90-day fill 90 days ago → 90 covered / 180 = 0.50
- Two 30-day fills 60 days apart → 60 covered / 180 = 0.33

## Boundary / failure modes

- Days of inpatient stay where statin was given by hospital pharmacy
  (not by outpatient fill) → count as covered (the patient was on the
  medication, just not from their own supply).
- Stockpiling: if a patient has a 90-day supply on hand at index and
  hasn't refilled in 70 days, they're still covered. The 90-day window
  cap counts as 90 days of supply at most per fill.
- Days_supply missing from the fill record → assume 30 days and
  document the assumption in a rationale.
