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

### Step 4 — Commit the component (do NOT score)
Determine ONE rechallenge outcome; the platform's `item_7_rechallenge` derivation
applies the +3/+1/−2/0 score. Anchor lab: ALT for hepatocellular; ALP (or
bilirubin) for cholestatic/mixed.

→ **Commit `rechallenge_result`** =
- `none_or_insufficient` — `rechallenge_flag=0` AND no note evidence; OR re-exposure confirmed but the lab data are insufficient to judge (this is the default)
- `positive_alone` — re-exposure confirmed (gap ≥ 45 days from T0), anchor lab doubled, suspect drug **alone**
- `positive_with_codrug` — same, but a co-drug was also present at re-exposure
- `below_uln` — re-exposure with an increase that stays below ULN

Only `positive_*` / `below_uln` require a confirmed re-exposure with a ≥ 45-day gap;
everything else is `none_or_insufficient`.

### Common mistakes
- Skipping notes when `rechallenge_flag=0`: inadvertent re-exposure is often only documented in notes.
- Committing a `positive_*` result without verifying the 45-day gap.
- Using ALT for cholestatic/mixed track: use ALP or bilirubin.
- Trying to output a +3/+1/−2 score: commit the `rechallenge_result` bucket only.
