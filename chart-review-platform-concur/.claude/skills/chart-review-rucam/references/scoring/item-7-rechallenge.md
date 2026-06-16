# Item 7 — Response to Readministration (Rechallenge)

**Goal:** Determine whether re-exposure to the suspect drug reproduced liver injury.

### Step 1 — Check structured flag
- `get_patient_summary` → `rechallenge_flag`

### Step 2 — Always check notes regardless of flag
- The structured flag may be miscoded (false negatives are common)
- Keywords: "rechallenge", "re-exposure", "restarted", "resumed", "inadvertent", "took again", drug name + "again"

### Step 3 — Validate rechallenge gap
- Valid rechallenge requires **≥ 45 days** between T0 and re-exposure
- Re-exposure within 45 days of T0 does NOT qualify (may be continuation of injury)

### Step 4 — Score
If `rechallenge_flag=0` AND no note evidence → **score = 0**, stop.

If re-exposure confirmed (flag=1 OR note evidence) AND gap ≥ 45 days from T0:

| Condition | Score |
|---|---|
| Anchor lab doubled; suspect drug alone | +3 |
| Anchor lab doubled; co-drug also present | +1 |
| Increase observed but remains below ULN | -2 |
| Re-exposure confirmed; lab data insufficient | 0 |

Anchor lab: ALT for hepatocellular; ALP (or bilirubin) for cholestatic/mixed.

### Common mistakes
- Skipping notes when `rechallenge_flag=0`: inadvertent re-exposure is often only documented in notes.
- Scoring without verifying the 45-day gap.
- Using ALT for cholestatic/mixed track: use ALP or bilirubin.
