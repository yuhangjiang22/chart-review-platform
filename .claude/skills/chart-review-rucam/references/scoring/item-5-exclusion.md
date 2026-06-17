# Item 5 — Exclusion of Other Causes

**Goal:** Systematically rule out alternative causes of liver injury.

### Step 0 — MANDATORY: anchor on the structured floor (`score_item5_exclusion`)

**Call `score_item5_exclusion(person_id)` FIRST, before scoring.** It returns,
from structured data, each cause's status under the strict rule (a NEGATIVE test
= ruled out; a POSITIVE test / present diagnosis = a competing cause, NOT
excluded; no test / flag = 0 = NOT ruled out), plus a `recommended_floor`.

**Your item_5 score starts AT the floor. You may only move it with evidence:**
- **RAISE above the floor** ONLY by citing, per cause, an explicit NOTE
  exclusion for a cause the tool marked `not_assessed` (a negative test result
  in a note, or an explicit "denies / no evidence of …"). Each such cause
  upgrades the ruled-out count. A structured flag of 0 is NOT a justification —
  you need a note quote. **Never return a score above the floor without naming
  the notes that justify it.**
- **LOWER toward −3** if a `competing_cause` clearly explains the injury.
- If you cannot justify moving it, **use the floor.**

This exists because asserting "all causes excluded" (→ +1) without the per-cause
work is the most common error. The floor makes that impossible: most causes are
`not_assessed` in structured data, so +1/+2 requires real note evidence.

### Step 1 — Collect structured flags (`get_patient_summary`)

**Hypotension/shock/ischemia (within 2 weeks):**
`hypotension_14d`, `shock_14d`, `acute_MI_14d`, `ischemic_hepatitis_14d`, `sbp_low_flag_14d`, `min_sbp_14d`

**Infection/sepsis:** `sepsis_dx`, `septicemia_dx`, `bacteremia_dx`

**Autoimmune:** `autoimmune_hepatitis_hx`, `liver_biopsy_proc`

**Chronic liver disease:** `PBC_PSC_hx`, `chronic_hep_B_hx`, `chronic_hep_C_hx`, `cirrhosis_hx`, `portal_hypertension_hx`, `ascites_hx`, `varices_hx`, `hepatic_encephalopathy_hx`, `sbp_hx`, `variceal_hemorrhage_hx`

**Biliary:** `biliary_obstruction_dx`, `biliary_imaging_proc`, `ercp_proc`

**Viral (acute):** `CMV_acute_dx`, `EBV_acute_dx`, `HSV_hepatitis_dx`

**Alcohol:** `alcohol_use_disorder`, `alcoholic_liver_disease`

**Serology flags in derived_rucam.csv:**
`HAV_IgM_result`, `HBsAg_result`, `HBc_IgM_result`, `HCV_Ab_result`, `HCV_RNA_result`,
`ANA_result`, `ANA_titer_result`, `SMA_result`, `IgG_result`,
`CMV_IgM_result`, `CMV_PCR_result`, `EBV_result`, `EBV_VCA_IgM_result`, `EBV_PCR_result`, `HSV_PCR_result`

### Step 2 — Collect serology (`get_serology`)
Raw values and dates for: HAV_IgM, HBsAg, HBc_IgM, HCV_Ab, HCV_RNA, ANA, SMA, IgG, CMV_IgM, CMV_PCR, EBV, EBV_VCA_IgM, EBV_PCR, HSV_PCR

### Step 3 — Check blood alcohol (both sources)
`get_serology(lab_name="Blood_alcohol")` AND `get_lft_series(lab_name="Blood_alcohol")`

### Step 4 — Check conditions and notes
- `get_conditions` → ICD codes for alternative diagnoses
- **Filter conditions by window for each Group II cause:**
  - Chronic HBV/HCV, PBC/PSC, Sepsis: `DAYS_FROM_LIVER_INJURY` ∈ [-365, +30]
  - acute CMV/EBV/HSV: `DAYS_FROM_LIVER_INJURY` ∈ [-30, +30]
  - Autoimmune hepatitis history: `DAYS_FROM_LIVER_INJURY` ∈ [-365, +30]
- Note keywords to search: "sepsis", "ischemia", "shock", "biliary", "obstruction", "ERCP", "alcohol", "hepatitis", "pancreatitis", "HAV", "HBV", "HCV", "CMV", "EBV", "cirrhosis", "PBC", "PSC", "sclerosing cholangitis", "AMA"

### Step 5 — Label every cause with (a), (b), or (c)

**Three-way status — use exactly one label per cause:**
- **(a) ruled out by objective testing** — test performed AND result negative (e.g., HAV_IgM tested and negative; imaging showing no biliary dilation)
- **(b) explicitly absent by history/exam** — notes explicitly exclude it (e.g., "denies alcohol use × 3 years"); flag = 0 alone is NOT sufficient for (b)
- **(c) not assessed / unknown** — no test, no explicit note exclusion; cannot be counted as ruled out

**Record in structured_evidence for every Group I cause and Group II category** (even if −3 applies):
```
[cause]: (a)/(b)/(c) — [one-line evidence summary]
```

**Group I (all 6):**
1. HAV within T0 ±30 days — HAV_IgM serology
2. HBV within T0 ±30 days — HBsAg + HBc_IgM + chronic_hep_B_hx
3. HCV within T0 ±30 days — HCV_Ab + HCV_RNA + chronic_hep_C_hx
4. Biliary obstruction within T0 ±30 days— biliary flags + imaging notes
5. Alcoholism — window: T0 −365 to T0 +30 days. alcohol flags + blood alcohol + AST:ALT ≥ 2 in notes
6. Hypotension/shock/ischemia within T0 ±2 weeks — ischemia flags

**Group II — check with explicit time windows:**
- **Autoimmune hepatitis — window: T0 −365 to T0 +30 days.** — ANA/SMA/IgG serologies (any time pre-injury, most informative near T0), liver biopsy, hepatology consult notes
- **Sepsis / bacteremia — window: T0 −365 to T0 +30 days.** check `sepsis_dx`, `bacteremia_dx`, `septicemia_dx`, notes from admission
- **Chronic hepatitis B/C complications — window: T0 −365 to T0 +30 days.** Use `get_conditions` and filter `DAYS_FROM_LIVER_INJURY` ∈ [-365, +30]; also search notes for "cirrhosis", "decompensated", "HCV cirrhosis", "HBV flare", "hepatic decompensation", "variceal bleed", "ascites". A known chronic HBV/HCV with recent flare/decompensation in this window is a plausible non-drug cause.
- **PBC/PSC — window: T0 −365 to T0 +30 days.** Use `get_conditions` filtered to [-365, +30]; also search notes for "primary biliary", "PBC", "sclerosing cholangitis", "PSC", "AMA" (anti-mitochondrial Ab), "MRCP". Absence of any mention in this window → (c) not assessed.
- **CMV / EBV / HSV acute — window: T0 ±30 days.** Check `CMV_acute_dx`, `EBV_acute_dx`, `HSV_hepatitis_dx` and the corresponding serologies (`CMV_IgM`, `EBV_VCA_IgM`, `HSV_PCR`, `CMV_PCR`, `EBV_PCR`) with measurement dates in [-30, +30].

**What counts as ruled out:** Only (a) and (b). (c) = NOT ruled out.
Structured flag = 0 does NOT override notes — if notes document an active diagnosis, it is not ruled out.

### Step 6 — Check for −3 first (before counting)
Score **−3 = non-drug cause highly probable** using this standard:

> **Clear alternative diagnosis explains the liver injury pattern, or there is strong evidence of another severe non-drug cause that is sufficient to account for the injury.**

Apply the standard — do not require a specific keyword. The evidence must be *sufficient to account for the injury*, not merely present. Typical qualifying scenarios:
- Clinician explicitly attributes the LFT elevation to a non-drug cause (e.g. "shock liver 2/2 cardiogenic shock", "transaminitis from sepsis")
- Confirmed active alternative diagnosis during the injury admission: septic shock / bacteremia with ischemic hepatopathy, biliary obstruction with dilated ducts on imaging, confirmed acute viral hepatitis (positive HAV IgM / HBc IgM / HCV RNA with no prior chronic infection)
- ICD diagnosis of sepsis (A41.x), ischemic hepatitis (K76.2, K76.3), or acute viral hepatitis (B15–B17) coded at the injury admission
- Severe hypotension / hemorrhagic shock with the characteristic rapid-rise-and-fall ALT/AST pattern (rise into thousands within 24–48h, then halves within days) — **but only if** notes or labs support ischemic hepatopathy as the mechanism (not just low BP alone)

**Do NOT apply −3 when:**
- An alternative cause is mentioned but not attributed (e.g., cholelithiasis on imaging without ductal dilation → not sufficient)
- Labs are inconclusive (e.g., viral serology "pending")
- Only a risk factor is present (e.g., chronic HCV without evidence of flare/decompensation at T0)

If −3 applies, stop — do not proceed to Group I counting.

### Step 7 — Count Group I (only if −3 does not apply)
- All Group I + Group II ruled out → **+2**
- All 6 Group I ruled out (Group II uncertain) → **+1**
- 5 or 4 Group I ruled out → **0**
- Fewer than 4 Group I ruled out → **-2**

### Common mistakes
- Stopping note reads early once −3 evidence is found: read ALL notes in the window — a later note may change a (c) to (a) or (b).
- Not labeling every cause with (a)/(b)/(c): required for all Group I and Group II, even when −3 applies.
- Treating missing serology as negative: no test = label (c), not (a).
- Using (b) without a note quote: flag = 0 alone is (c), not (b).
- Trusting structured flags over notes: sepsis_dx=0 does not mean sepsis did not occur.
- Not calling both serology AND lft_series for blood alcohol.
- Skipping notes for biliary obstruction: imaging reports are often only in notes.
