# Item 3 — Risk Factors

**Goal:** Identify patient factors that increase susceptibility to DILI.

### Step 1 — Call `get_patient_summary`
Check:
- `alcohol_use_disorder` (1 = present)
- `alcoholic_liver_disease` (1 = present)
- `pregnancy` (1 = present)
- `AGE` (years at liver injury date)

### Step 2 — Verify alcohol and age in notes

**Only EXCESSIVE / HEAVY alcohol use counts as a risk factor.** Ordinary social or occasional drinking does NOT.

- **Counts (+1)**: documented alcohol use disorder, alcohol abuse/dependence, alcoholic liver disease, or heavy drinking — e.g. "ETOH abuse", "heavy alcohol use", "drinks a 6-pack daily", "history of alcoholism", ">2 drinks/day (men) or >1 drink/day (women)"
- **Does NOT count**: "occasional", "social drinker", "rare", "1 drink/month", "drinks socially", "Alcohol use: Yes" with no quantity or with a light quantity
- If quantity is documented but light/moderate (at or below ~2 drinks/day men, ~1 drink/day women), the factor is **absent**
- If notes are ambiguous ("Alcohol use: Yes" with no further detail) and both structured flags are 0, treat the factor as **absent**

Notes are primary clinical evidence: documented *heavy* use counts even when `alcohol_use_disorder=0` and `alcoholic_liver_disease=0`. But notes showing only light/occasional use do NOT create the factor.

- Search notes for: "alcohol", "ETOH", "drinks", "beer", "wine", "liquor"
- If notes document a DOB or age that contradicts the structured `AGE`, document it; use structured `AGE` as primary unless notes clearly contradict it.

### Step 3 — Score (max +2)

**Hepatocellular track (R > 5):**
- Excessive/heavy alcohol use (per Step 2) OR alcoholic liver disease present → **+1**
- Age ≥ 55 years → **+1**
- **Pregnancy does NOT count on this track**

**Cholestatic/Mixed track (R ≤ 5):**
- Excessive/heavy alcohol use (per Step 2) OR alcoholic liver disease OR pregnancy present → **+1**
- Age ≥ 55 years → **+1**

Both factors can apply simultaneously (max +2 on either track).

### Common mistakes
- Applying pregnancy to the hepatocellular track: pregnancy is a risk factor on cholestatic/mixed only.
- Capping at +1: both age and alcohol can stack to +2.
- Ignoring `alcoholic_liver_disease` as separate from `alcohol_use_disorder`: either flags the alcohol factor.
- **Counting light/occasional drinking as the alcohol risk factor**: "occasional", "social drinker", "1 drink/month", or a bare "Alcohol use: Yes" do NOT qualify. The factor requires excessive/heavy use, alcohol use disorder, or alcoholic liver disease.
- Treating any note mention of alcohol as confirmation: read the quantity/qualifier before counting it.
