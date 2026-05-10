---
field_id: statin_active_at_index
prompt: At the index date, does the patient have an active statin prescription?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window_check: skip  # point-in-time per Phase 4.6; "prior 90 days" describes internal fill-supply check, not a frontmatter window
---

## Definition

A statin prescription is "active" at the index date if a current order
for any HMG-CoA reductase inhibitor (atorvastatin, rosuvastatin,
simvastatin, pravastatin, pitavastatin, lovastatin, fluvastatin) is on
the medication list at index, OR the patient has refilled within the
prior 90 days such that supply could plausibly cover the index date.

Point-in-time evaluation — no time_window in frontmatter (per Phase
4.6: index-time attribute).

## Extraction guidance

- Read the active medication list at the index encounter.
- Cross-check pharmacy fill data: a fill in the last 90 days with a
  90-day supply means the patient has medication on hand at index even
  if the prescription line on the encounter doesn't show it.
- Discontinued statins (clinician note: "stopped due to myalgia") are
  NOT active.

## Examples

**Satisfying ("yes"):**
- Med list at index includes "atorvastatin 40mg daily"
- Last fill 60 days ago, 90-day supply

**Non-satisfying ("no"):**
- Med list shows "Discontinued: simvastatin (myopathy)"
- Patient never had a statin prescription
- Last fill 200 days ago with a 90-day supply (gap > 0)

## Boundary / failure modes

- Statin held peri-procedurally → if the hold is still active at index,
  it's "no". If hold ended before index, "yes".
- Statin combined product (e.g. amlodipine/atorvastatin) → "yes".
- Over-the-counter red yeast rice → not a prescription statin → "no".
