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

### Step 3 — Commit the components (do NOT score)
Report each factor as a plain yes/no. The platform's `item_3_risk_factors`
derivation handles the track logic (pregnancy only counts on cholestatic/mixed)
and the stacking — you do not apply the track rule yourself.

→ **Commit `rf_alcohol`** = `yes` if alcohol use disorder **or** alcoholic liver
disease is present (structured flag = 1 **or** clinician-documented alcohol
use/abuse in notes), else `no`.
→ **Commit `rf_pregnancy`** = `yes` if pregnancy is present, else `no`. (Report it
regardless of track — the derivation applies it only on cholestatic/mixed.)
→ **Commit `rf_age_ge_55`** = `yes` if `AGE` ≥ 55 years at T0, else `no`.

### Common mistakes
- Withholding `rf_pregnancy` on a hepatocellular case: always report it; the
  derivation decides whether it counts.
- Ignoring `alcoholic_liver_disease` as separate from `alcohol_use_disorder`:
  either one flags `rf_alcohol = yes`.
- Trying to output a +1/+2 score: commit the yes/no flags only.
