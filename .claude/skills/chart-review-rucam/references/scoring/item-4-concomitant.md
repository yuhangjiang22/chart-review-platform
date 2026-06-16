# Item 4 — Concomitant Drugs

**Goal:** Assess whether co-medications could be an alternative explanation for liver injury.

### Step 1 — Get prescription drugs from structured data
- `get_medications(in_90day_window=True)` → all drugs with `IN_90DAY_WINDOW=1`
- **Explicitly exclude the suspect drug** — Item 4 covers concomitant drugs only
- Collect the set of distinct concomitant `DRUG_NAME`s

### Step 1b — Build merged episodes for each concomitant drug
For every distinct concomitant drug, call `get_drug_episodes(drug_name=<name>)`. This applies the 45-day gap rule deterministically and returns one or more episodes with `start_day`, `end_day`, `n_fills`, and `relative_to_t0` (`ongoing_at_t0` / `stopped_before` / `started_after`).

**Use the episodes — not individual fills — to assess timing.** A drug with two fills 30 days apart is ONE episode (continuous), not two re-exposures.

### Step 2 — Systematic note search for OTC/herbal/unlisted meds
Structured data only captures prescriptions. Notes are the only source for OTC drugs, herbals, supplements, and home meds the patient took before admission.

**Required searches (run each):**
- Common OTC hepatotoxins: `"ibuprofen"`, `"naproxen"`, `"acetaminophen"`, `"Tylenol"`, `"aspirin"`, `"NSAID"`
- Herbals: `"herbal"`, `"supplement"`, `"vitamin"`, `"kava"`, `"St. John"`, `"green tea"`, `"valerian"`
- Generic capture: `"home meds"`, `"home medications"`, `"OTC"`, `"over the counter"`
- Medication reconciliation sections: if `search_notes("home meds")` returns a hit, do a Pass 3 full read of that note to see the full home-med list — many home meds are only in these sections

**Also check**: Medication sections of H&P, ED notes, and discharge summaries (use `get_note_section(sections=["Medications"])` if Pass 2 doesn't capture them).

### Step 3 — Assess each concomitant drug's hepatotoxicity — use `get_hepatotoxicity_category`
**For every concomitant drug found (structured or notes), call `get_hepatotoxicity_category(drug_name)`.** Do not rely on parametric knowledge — the LiverTox masterlist (1,715 drugs) is the authoritative source.

Record for each drug: `{drug, category (A–E or not listed), timing (suggestive/compatible/incompatible), active_at_T0}`.

### Step 4 — Check timing compatibility for each drug
Using the merged episodes from Step 1b:
- Timing is **suggestive** if:
  - Injury type is **Hepatocellular injury (R > 5)** and either:
    - `ongoing_at_t0`, initial treatment, with `start_day` between `-5 to -90`; or
    - `ongoing_at_t0`, re-exposure, with `start_day` between `-1 to -15`.
  - Injury type is **Cholestatic or mixed injury (R ≤ 5)** and either:
    - `ongoing_at_t0`, initial treatment, with `start_day` between `-5 to -90`; or
    - `ongoing_at_t0`, re-exposure, with `start_day` between `-1 to -90`.

- Timing is **compatible** if:
  - Injury type is **Hepatocellular injury (R > 5)** and either:
    - `ongoing_at_t0`, initial treatment, with `start_day` `> -5 or < -90`; or
    - `ongoing_at_t0`, re-exposure, with `start_day` `< -15`; or
    - `stopped_before` with `end_day` `≥ -15`
  - Injury type is **Cholestatic or mixed injury (R ≤ 5)** and either:
    - `ongoing_at_t0`, initial treatment, with `start_day` `> -5 or < -90`; or
    - `ongoing_at_t0`, re-exposure, with `start_day` `< 90`; or
    - `stopped_before` with `end_day` `≥ -30`

- Timing is **incompatible** if the timing criteria do not meet the calculable window:
  - Injury type is **Hepatocellular injury (R > 5)** and `stopped_before` with `end_day` `< -15 days`
  - Injury type is **Cholestatic or mixed injury (R ≤ 5)** and `stopped_before` with `end_day` `< -30 days`
  - **Any injury type:**
    - exposure `started_after` T0
    - `start_day` is 0
    - insufficient information to determine exposure timing or latency


### Step 5 — Score (choose the single worst-case drug)

**Decide each drug's score using this two-step algorithm**:

1. **Start at 0**. If timing is **incompatible** → score **0** (drug doesn't matter).
2. If timing is **suggestive OR compatible** → start at **-1**.
3. **Upgrade to -2** ONLY IF: hepatotoxicity is **Category A or B** AND timing is **suggestive** (both conditions required).
4. **Override to -3** only with clear evidence the drug is the actual cause (positive rechallenge, distinctive signature, or explicit clinician attribution).

**Full scoring grid** (every combination is covered — no gaps):

| Timing \ Category | A or B (known hepatotoxic) | C / D / E / not-listed |
|---|---|---|
| **Suggestive** (5–90d initial / 1–15d re-exposure for hep; 5–90d / 1–90d for chol-mixed) | **-2** | **-1** |
| **Compatible** (ongoing-at-T0 outside suggestive window, or stopped within carry-over) | **-1** | **-1** |
| **Incompatible** (stopped well before T0, started after, or insufficient info) | **0** | **0** |

Then apply: **-3 override** if there's clear attribution (positive rechallenge, distinctive signature, or clinician explicitly names the drug as the cause).

**Final rule**: Pick the drug with the worst (most-negative) score; that becomes Item 4's score.

**Worked examples**:
- Atorvastatin (Cat A), ongoing at T0, started 244d before T0 (chronic) → timing **compatible** (not suggestive, since outside 5–90d window) → score **-1**
- Atorvastatin (Cat A), started 30d before T0 → timing **suggestive** (within 5–90d) → score **-2**
- Sitagliptin (Cat C), started 30d before T0 → timing **suggestive** + non-hepatotoxic → score **-1** (not upgraded)
- Furosemide (Cat E), stopped 60d before T0 → timing **incompatible** (>45d carry-over for compatible) → score **0**
- Lisinopril (Cat B), stopped 10d before T0 (within 45d carry-over) → timing **compatible** → score **-1**

### Common mistakes
- Skipping `get_hepatotoxicity_category` and guessing categories from memory: the masterlist is authoritative; always call the tool.
- Forgetting to search notes for OTC meds: home acetaminophen or ibuprofen is often only in the HPI/home-meds section, not structured data.
- Including the suspect drug: Item 4 is about concomitant drugs only.
- Not applying the 45-day gap rule: a drug that stopped 40 days before T0 may still have compatible timing.
- Scoring -2 for Cat A/B with chronic exposure (start_day outside −5 to −90d): the -2 upgrade requires BOTH Cat A/B AND suggestive timing. Chronic Cat A/B drugs ongoing at T0 score **-1**, not -2.
- Forgetting that Cat C/D/E/not-listed drugs with suggestive timing still score **-1** (they meet the baseline -1 rule but never qualify for the -2 upgrade).
