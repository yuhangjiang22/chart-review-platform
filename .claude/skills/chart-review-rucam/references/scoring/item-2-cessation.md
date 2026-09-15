# Item 2 — Course After Cessation

**Goal:** Determine whether liver enzymes improved after stopping the suspect drug.

### Step 1 — Determine drug stop date (D_stop)
- `get_suspect_drug` → `SELECTED_DRUG`
- `get_drug_episodes(drug_name=<SELECTED_DRUG>)` → returns merged episodes with `end_day` (= drug stop day relative to T0)
- **Always search notes** for "discontinued", "stopped", "held", "DC'd", "STOP taking" — note evidence may move D_stop earlier than structured `end_day` (e.g., clinically held during admission)
- D_stop is the relevant episode's `end_day` (or earlier note-based stop if documented)

**IMPORTANT — what "drug continued" means**:
- "Drug continued" means the drug was **NEVER stopped** within the observation window — i.e., NO end date for the relevant episode at any point through the available follow-up. This is the only case that triggers `score = 0, stop`.
- `ACTIVE_AT_LIVER_INJURY=1` alone does **NOT** mean "drug continued" — it only flags active-at-T0. If the drug was stopped LATER (any time after T0), dechallenge IS assessable.
- A drug `ongoing_at_t0` with a finite `end_day` (e.g., end_day=+46) = stopped after onset → proceed to scoring with D_stop = end_day.

If drug truly continued (no end_day in any episode AND no note evidence of cessation): **score = 0, stop.**

Otherwise — including drug stopped before OR after T0 — proceed to Step 2.

### Step 2 — Get peak anchor lab(s) — use `get_lab_extremum`
Anchor labs per track:
- Hepatocellular: `ALT`
- **Cholestatic/Mixed: BOTH ALP AND total bilirubin — compute score for each and take the best (highest).** Do not skip bilirubin just because ALP is available.

**Lab names vary by dataset** (bilirubin may be `BILI`, `bilirubin`, `TBILI`, …). Call `get_lft_series(person_id)` without a `lab_name` filter to see the actual `LAB_NAME` values, then use the exact string present. Never conclude a lab is missing without checking the real names first.

ULN defaults: ALT = 52, ALP = 125 (the tool returns per-row `uln` from the data when present).

**Peak call (let `D_stop` = drug stop day from T0; negative if stopped before onset):**
- Drug stopped **after** onset (D_stop ≥ 0): `get_lab_extremum(lab_name=<anchor>, stat="max", day_min=0, day_max=D_stop)`
- Drug stopped **before** onset (D_stop < 0): peak = **onset value** (the lab value at T0, not the post-stop maximum). Use `get_lab_extremum(stat="max", day_min=0, day_max=0)`; if no value at day 0, use the nearest available value within ±3 days of T0 from `get_lft_series`.

### Step 3 — Check each scoring window independently — use `get_lab_extremum`

**Key principle:** Check each tier's window independently, from most strict to least strict. A tier is met if **any** value in that window achieves ≥50% decrease from peak. Use `get_lab_extremum(stat="min")` for each window separately — if the minimum of a window achieves ≥50% decrease, at least one value in that window meets the threshold.

% decrease = (peak − value) / peak × 100.

**Hepatocellular — check in this order, stop at first tier met:**
1. +3 window `[D_stop+1, D_stop+8]`: `get_lab_extremum("ALT","min", day_min=D_stop+1, day_max=D_stop+8)` — if min achieves ≥50% decrease → **+3**
2. +2 window `[D_stop+9, D_stop+30]`: `get_lab_extremum("ALT","min", day_min=D_stop+9, day_max=D_stop+30)` — if min achieves ≥50% decrease → **+2**
3. >30 window `[D_stop+31, ∞]`: `get_lab_extremum("ALT","min", day_min=D_stop+31)` — if min achieves ≥50% decrease → **0**
4. If no window achieves ≥50% decrease, or no follow-up data → **−2** (recurrent increase or no improvement) or **0** (truly no data)

**Cholestatic/Mixed — run for ALP AND total bilirubin separately (use the exact lab names found in the data); take the BEST score:**
- `get_lab_extremum(<anchor>,"min", day_min=D_stop+1, day_max=D_stop+180)` — if any value achieves ≥50% decrease in this window → **+2**
- <50% decrease in both within 180 days → **+1**
- Persistence/increase in both, or no follow-up data for **both** → **0**

### Step 4 — Score by track

**Hepatocellular (ALT):**
- ≥50% decrease achieved by any value within 8 days of drug stop → **+3**
- ≥50% decrease achieved by any value within 30 days (not within 8) → **+2**
- ≥50% decrease achieved only after 30 days, OR no follow-up data → **0**
- <50% decrease after 30 days, OR recurrent increase → **−2**

**Cholestatic/Mixed (ALP and total bilirubin, take BEST):**
- ≥50% decrease in ALP OR bilirubin achieved by any value within 180 days → **+2**
- <50% decrease in both ALP and bilirubin within 180 days → **+1**
- Persistence/increase in both, or no follow-up data for **both** → **0**

**If only one anchor has data**, score from that anchor alone — do not drop to 0 because the other is missing.

### Note review — Item 2
- Keywords: drug name, "discontinued", "stopped", "held", "DC'd", "resumed", "restarted", "STOP taking"
- "STOP taking these medications" is a common discharge medication reconciliation format — if `search_notes("STOP taking")` returns a hit, do a Pass 3 full read of that note to see which drugs are listed for discontinuation
- Look for any note that contradicts `ACTIVE_AT_LIVER_INJURY` (e.g., drug held clinically but flag=1)

### Common mistakes
- **Treating `ACTIVE_AT_LIVER_INJURY=1` as "drug continued"**: this flag only means active at T0. If the drug stopped LATER (e.g., end_day=+46), dechallenge IS assessable — use D_stop = end_day. "Drug continued" only applies when the drug was never stopped.
- Peak = all post-T0 max: wrong — peak is capped at drug stop date (for drug stopped after onset).
- **Wrong peak for D_stop < 0**: when drug stopped before onset, peak = onset value (T0), NOT the post-stop maximum. Use `get_lab_extremum(stat="max", day_min=0, day_max=0)`.
- Counting days from T0 instead of from drug stop: dechallenge window starts at drug stop.
- **Checking one combined window instead of tier windows separately**: run `get_lab_extremum("min")` for each tier's specific window ([D_stop+1, D_stop+8], then [D_stop+9, D_stop+30], then [D_stop+31, ∞]) in order and stop at the first that achieves ≥50% decrease.
- **Skipping bilirubin for cholestatic/mixed**: the guideline says "ALP or total bilirubin" — check BOTH and use whichever gives the better score. Do not skip bilirubin just because ALP is available.
- **Declaring a lab unavailable because of its name**: a name mismatch is not missing data. List the actual `LAB_NAME` values first.
- **Scoring 0 because one anchor is missing**: score from the anchor that has data; 0 requires both to lack follow-up.

## Committing this item on the platform

**Do not answer `item_2_course` — it is computed.** The scoring thresholds above tell you
what the score *will* be; the platform applies them. What you commit is
`dechallenge_outcome`, and the `item_2_course` derivation turns
those into the score. `list_criteria` shows the exact leaf fields and their
allowed values. Calling `set_field_assessment` on `item_2_course`,
`rucam_total_score` or `rucam_causality_category` is always wrong.
