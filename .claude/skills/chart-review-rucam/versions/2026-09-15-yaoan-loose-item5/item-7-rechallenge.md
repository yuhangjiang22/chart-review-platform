# Item 7 — Response to Readministration (Rechallenge)

**Goal:** Determine whether re-exposure to the suspect drug reproduced liver injury.

### Step 1 — Check structured flag
- `get_patient_summary` → `rechallenge_flag`

### Step 2 — Identify re-exposure episodes from both structured data and notes
- **Structured**: `get_drug_episodes(drug_name=<SELECTED_DRUG>)` — any episode after the original T0 episode is a potential re-exposure
- **Notes**: search regardless of flag (may be miscoded). Keywords: "rechallenge", "re-exposure", "restarted", "resumed", "inadvertent", "took again", drug name + "again"

There may be multiple re-exposure episodes — check **each one** independently.

**Key terms:**
- **D_stop_prev** = the stop date of the drug episode immediately preceding each re-exposure (could be the original T0 stop, or the stop after a prior re-exposure)
- **D_stop_rechallenge** = the stop date of that specific re-exposure episode (when the drug was stopped again after re-exposure)

### Step 3 — Validate rechallenge gap (per re-exposure)
For each re-exposure episode:
- Gap = re-exposure start date − **D_stop_prev**
- Valid rechallenge requires gap **> 45 days**
- Gap ≤ 45 days → continuous use, not a true rechallenge → skip this episode

### Step 4 — Score
If `rechallenge_flag=0` AND no note evidence → **score = 0**, stop.

For each valid re-exposure episode (gap > 45 days), assess the lab response and assign the best score across all episodes:

| Condition | Score |
|---|---|
| Anchor lab doubled; suspect drug alone | +3 |
| Anchor lab doubled; co-drug also present | +1 |
| Any uptick in anchor lab after re-exposure but remains below ULN | -2 |
| Re-exposure confirmed; lab data insufficient | 0 |

Anchor lab: ALT for hepatocellular; ALP (or bilirubin) for cholestatic/mixed.

**Definitions:**
- **Baseline**: the closest anchor-lab record within 180 days before each re-exposure start. Use `get_lft_series(lab_name=<anchor>, day_max=<re-exposure start day - 1>)` and pick the record nearest to re-exposure.
- **"Doubled"**: the anchor lab rises to ≥2× the baseline. Check lab values in the window [re-exposure start, **D_stop_rechallenge**] — after the drug is restarted and before it is stopped again.

### Common mistakes
- Skipping notes when `rechallenge_flag=0`: inadvertent re-exposure is often only documented in notes.
- Scoring without verifying the 45-day gap.
- Using ALT for cholestatic/mixed track: use ALP or bilirubin.
