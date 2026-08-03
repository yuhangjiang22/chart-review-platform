# Item 5 — Exclusion of Other Causes

**Goal:** Systematically rule out alternative causes of liver injury.

### Step 0 — MANDATORY: anchor on the structured floor (`score_item5_exclusion`)

**Call `score_item5_exclusion(person_id)` FIRST.** It returns, from structured
data, each cause's status under the strict rule (a NEGATIVE test = ruled out; a
POSITIVE test / present diagnosis = a competing cause, NOT excluded; no test /
flag = 0 = NOT ruled out). Item 5 is **decomposed** — you do not score it. You set
one yes/no flag per cause (6 Group I + 5 Group II) plus `alt_cause_explains`, and
the platform derives item_5 (+2 / +1 / 0 / −2, or −3) from your flags.

**Each per-cause flag starts at the tool's status. You may only raise a flag to
`yes` with evidence:**
- **Set a flag to `yes`** only when the cause is ruled out — the tool marked it
  ruled out (negative structured test), **or** you cite an explicit NOTE exclusion
  (a negative test result in a note, or an explicit "denies / no evidence of …").
  A structured flag of 0 is NOT enough — for a `not_assessed` cause you need a note
  quote. **Never set a flag to `yes` without the evidence that justifies it.**
- **Set `alt_cause_explains = yes`** if a `competing_cause` clearly explains the
  injury (drives the −3 override).
- If you cannot justify ruling a cause out, leave its flag `no`.

This matters because asserting "all causes excluded" without the per-cause work is
the most common error. Most causes are `not_assessed` in structured data, so a `yes`
flag requires real note evidence.

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

**Reuse a negative result across causes — a documented negative is (a) even if it was
ordered for another cause or is not labeled with this cause's name.** A negative result
in the chart rules out its cause regardless of *why* it was drawn — do NOT downgrade a
*present* negative to (c) just because no test or note names that specific cause:
- negative **AMA** (usually from the autoimmune panel) → PBC = (a); a clean biliary tree on US/MRCP → PSC = (a)
- negative **ANA / SMA / IgG** (or biopsy/hepatology assessment not AIH) → autoimmune = (a)
- a hepatology/acute-hepatitis panel with negative **CMV/EBV/HSV** PCR or serology → acute viral = (a)
- a documented negative **sepsis workup** (negative cultures, low/normal procalcitonin, or clinician documents no septic source / low suspicion) → sepsis = (a)
- **no known chronic HBV/HCV history + negative HBsAg/anti-HCV** (or HBV DNA/HCV RNA) → chronic HBV/HCV = (a)

This does NOT loosen the anti-fabrication rule above: you still need a **real, cited
negative result** — genuinely absent data (no relevant test/note in the window) stays
(c)/`no`. The fix is only that a negative already in the chart must be *credited*, not
re-labeled "not assessed."

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

**Map each label to its flag** — (a) or (b) → `yes`; (c) → `no`. Commit one flag
per cause (the platform counts them; `n_group1_ruled_out` and `group2_all_ruled_out`
are derived — do not commit those):

| Cause | Field to commit |
|---|---|
| Group I · HAV | `g1_hav_ruled_out` |
| Group I · HBV | `g1_hbv_ruled_out` |
| Group I · HCV | `g1_hcv_ruled_out` |
| Group I · biliary obstruction | `g1_biliary_obstruction_ruled_out` |
| Group I · alcoholism | `g1_alcoholism_ruled_out` |
| Group I · hypotension/shock/ischemia | `g1_ischemia_ruled_out` |
| Group II · autoimmune hepatitis | `g2_autoimmune_ruled_out` |
| Group II · sepsis/bacteremia | `g2_sepsis_ruled_out` |
| Group II · chronic HBV/HCV complications | `g2_chronic_hbv_hcv_ruled_out` |
| Group II · PBC/PSC | `g2_pbc_psc_ruled_out` |
| Group II · acute CMV/EBV/HSV | `g2_cmv_ebv_hsv_ruled_out` |

Commit **all 11** flags, even a `no` — a missing flag leaves item 5 Pending.

### Step 6 — Decide `alt_cause_explains` (the −3 override)
Set **`alt_cause_explains = yes`** when a non-drug cause is highly probable —
i.e. it is *sufficient to account for the injury* — using this standard:

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

Set `alt_cause_explains = no` otherwise. (When it is `yes`, the platform derives
item_5 = −3 regardless of the ruled-out counts — but still commit every flag.)

### Step 7 — Commit the components (do NOT score or count)
→ **Commit all 11 per-cause flags** (`g1_*` ×6, `g2_*` ×5) as `yes`/`no` per the
Step 5 mapping, plus **`alt_cause_explains`** (`yes`/`no`) from Step 6.

The platform counts your Group I flags into `n_group1_ruled_out`, gates Group II
into `group2_all_ruled_out`, and derives item_5 (all-I-and-II → +2, all-I → +1,
4–5 of I → 0, <4 → −2; `alt_cause_explains=yes` → −3). **Do not** compute or commit
`item_5_exclusion`, `n_group1_ruled_out`, or `group2_all_ruled_out` — they are derived.

### Common mistakes
- Stopping note reads early once −3 evidence is found: read ALL notes in the window — a later note may change a (c) to (a) or (b).
- Not labeling every cause with (a)/(b)/(c): required for all Group I and Group II, even when −3 applies.
- Treating missing serology as negative: no test = label (c), not (a).
- Using (b) without a note quote: flag = 0 alone is (c), not (b).
- Trusting structured flags over notes: sepsis_dx=0 does not mean sepsis did not occur.
- Not calling both serology AND lft_series for blood alcohol.
- Skipping notes for biliary obstruction: imaging reports are often only in notes.
