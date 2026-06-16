# Item 3 — Risk Factors

**Goal:** Identify patient factors that increase susceptibility to DILI.

### Step 1 — Call `get_patient_summary`
Check:
- `alcohol_use_disorder` (1 = present)
- `alcoholic_liver_disease` (1 = present)
- `pregnancy` (1 = present)
- `AGE` (years at liver injury date)

### Step 2 — Verify alcohol and age in notes
- **Notes are primary clinical evidence.** If notes document alcohol use or abuse (e.g., "drinks X beers/day", "ETOH abuse", "heavy alcohol use") even when `alcohol_use_disorder=0` and `alcoholic_liver_disease=0`, count the alcohol risk factor — clinician-documented alcohol use overrides a missing structured flag.
- Search notes for: "alcohol", "ETOH", "drinks", "beer", "wine", "liquor"
- If notes document a DOB or age that contradicts the structured `AGE`, document it; use structured `AGE` as primary unless notes clearly contradict it.

### Step 3 — Score (max +2)

**Hepatocellular track (R > 5):**
- Alcohol use disorder OR alcoholic liver disease present → **+1**
- Age ≥ 55 years → **+1**
- **Pregnancy does NOT count on this track**

**Cholestatic/Mixed track (R ≤ 5):**
- Alcohol use disorder OR alcoholic liver disease OR pregnancy present → **+1**
- Age ≥ 55 years → **+1**

Both factors can apply simultaneously (max +2 on either track).

### Common mistakes
- Applying pregnancy to the hepatocellular track: pregnancy is a risk factor on cholestatic/mixed only.
- Capping at +1: both age and alcohol can stack to +2.
- Ignoring `alcoholic_liver_disease` as separate from `alcohol_use_disorder`: either flags the alcohol factor.
