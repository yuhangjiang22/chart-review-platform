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


### Step 5 — Commit the components (do NOT score)
Pick the **single worst-case concomitant drug** — the one with the most
implicating timing (`suggestive` beats `compatible` beats `incompatible`), and
among ties, the one that is hepatotoxic. Describe that drug with three components;
the platform's `item_4_concomitant` derivation applies the −1/−2/−3 logic.

→ **Commit `concomitant_worst_timing`** = the worst drug's timing from Step 4:
`suggestive` / `compatible` / `incompatible`, or `none` if there are no
concomitant drugs at all.
→ **Commit `concomitant_worst_hepatotoxic`** = `yes` if that worst-timing drug is
LiverTox **Category A or B**, else `no`.
→ **Commit `concomitant_attribution`** = `yes` only with clear evidence a
concomitant drug is the actual cause (its own positive rechallenge, a distinctive
signature, or a clinician explicitly naming it as the cause) — this drives the −3
override; else `no`.

**Worked examples** (observation → components):
- Atorvastatin (Cat A), ongoing at T0, started 244d before T0 (chronic) → timing `compatible` → `concomitant_worst_timing=compatible`, `concomitant_worst_hepatotoxic=yes`, `concomitant_attribution=no`
- Atorvastatin (Cat A), started 30d before T0 → timing `suggestive` → `suggestive` / `yes` / `no`
- Sitagliptin (Cat C), started 30d before T0 → timing `suggestive`, non-hepatotoxic → `suggestive` / `no` / `no`
- Furosemide (Cat E), stopped 60d before T0 → timing `incompatible` → `incompatible` / `no` / `no`
- No concomitant drugs at all → `none` / `no` / `no`

### Common mistakes
- Skipping `get_hepatotoxicity_category` and guessing categories from memory: the masterlist is authoritative; always call the tool.
- Forgetting to search notes for OTC meds: home acetaminophen or ibuprofen is often only in the HPI/home-meds section, not structured data.
- Including the suspect drug: Item 4 is about concomitant drugs only.
- Not applying the 45-day gap rule: a drug that stopped 40 days before T0 may still have compatible timing.
- Mislabeling chronic Cat A/B exposure as `suggestive`: a Cat A/B drug ongoing at T0 but started outside the −5 to −90d window is `compatible`, not `suggestive` (the derivation only reaches −2 when timing is `suggestive` AND hepatotoxic).
- Setting `concomitant_worst_hepatotoxic=yes` for a Cat C/D/E/not-listed drug: only Category A or B counts as hepatotoxic here.
- Trying to output a −1/−2/−3 score: commit the three component fields; the platform derives the score.
