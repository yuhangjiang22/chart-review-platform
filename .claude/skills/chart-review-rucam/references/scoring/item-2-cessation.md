# Item 2 — Course After Cessation

**Goal:** Determine whether liver enzymes improved after stopping the suspect drug.

### Step 1 — Determine drug stop date (D_stop)
- `get_suspect_drug` → `SELECTED_DRUG`
- `get_drug_episodes(drug_name=<SELECTED_DRUG>)` → returns merged episodes with `end_day` (= drug stop day relative to T0)
- **Always search notes** for "discontinued", "stopped", "held", "DC'd", "STOP taking" — note evidence may move D_stop earlier than structured `end_day` (e.g., clinically held during admission)
- D_stop is the relevant episode's `end_day` (or earlier note-based stop if documented)

**IMPORTANT — what "drug continued" means**:
- "Drug continued" means the drug was **NEVER stopped** within the observation window — i.e., NO end date for the relevant episode at any point through the available follow-up. This is the only case that maps to `dechallenge_outcome = not_stopped`.
- `ACTIVE_AT_LIVER_INJURY=1` alone does **NOT** mean "drug continued" — it only flags active-at-T0. If the drug was stopped LATER (any time after T0), dechallenge IS assessable.
- A drug `ongoing_at_t0` with a finite `end_day` (e.g., end_day=+46) = stopped after onset → proceed to scoring with D_stop = end_day.

If drug truly continued (no end_day in any episode AND no note evidence of cessation): **commit `dechallenge_outcome = not_stopped` and stop** (no peak/nadir work needed).

Otherwise — including drug stopped before OR after T0 — proceed to Step 2.

### Step 2 — Get peak anchor lab(s) — use `get_lab_extremum`
Anchor labs per track:
- Hepatocellular: `ALT`
- **Cholestatic/Mixed: BOTH `ALP` AND `bilirubin_total` — compute score for each and take the best (highest).** Do not skip bilirubin just because ALP is available.

ULN defaults: ALT = 52, ALP = 125 (the tool returns per-row `uln` from the data when present).

**Peak call (let `D_stop` = drug stop day from T0; negative if stopped before onset):**
- Drug stopped **after** onset (D_stop ≥ 0): `get_lab_extremum(lab_name=<anchor>, stat="max", day_min=0, day_max=D_stop)`
- Drug stopped **before** onset (D_stop < 0): `get_lab_extremum(lab_name=<anchor>, stat="max", day_min=D_stop+1)` — scan the entire post-stop series; peak may be T0 or later

### Step 3 — Find the nadir in the dechallenge window — use `get_lab_extremum`
**Nadir = the minimum anchor-lab value inside the dechallenge window, measured from the drug stop date.** Use the tool directly — do not scan the series manually.

Window (in days from T0, i.e. DAYS_FROM_LIVER_INJURY) for each scoring tier:
- Hepatocellular +3: `day_min=D_stop+1, day_max=D_stop+8` → `get_lab_extremum("ALT","min",...)`
- Hepatocellular +2: `day_min=D_stop+1, day_max=D_stop+30`
- Hepatocellular >30: `day_min=D_stop+1` (no upper bound)
- Cholestatic/Mixed: `day_min=D_stop+1, day_max=D_stop+180` (run once for ALP, once for bilirubin_total)

% decrease = (peak − nadir) / peak × 100. Compare to 50% threshold.

### Step 4 — Commit the component (do NOT score)
From the peak → nadir % decrease and the day the nadir occurs (measured from the
drug stop date), determine ONE outcome bucket. The platform's `item_2_course`
derivation applies the track-specific score. For cholestatic/mixed, evaluate ALP
and bilirubin separately and report the **best** (earliest/largest-decrease) bucket.

→ **Commit `dechallenge_outcome`** =
- `ge50_le8d` — ≥ 50% decrease, nadir within 8 days of drug stop
- `ge50_le30d` — ≥ 50% decrease, nadir within 30 days (but not within 8)
- `ge50_le180d` — ≥ 50% decrease reached only later, within 180 days
- `lt50_with_data` — follow-up data exist but the decrease stays < 50%
- `increase` — the anchor lab rises / recurs after the drug stop
- `no_followup` — the drug was stopped but there are no follow-up labs to judge the course
- (`not_stopped` was already handled in Step 1 if the drug never stopped)

Report the bucket only — the +3/+2/0/−2/+1 mapping is the platform's job.

### Note review — Item 2
- Keywords: drug name, "discontinued", "stopped", "held", "DC'd", "resumed", "restarted", "STOP taking"
- "STOP taking these medications" is a common discharge medication reconciliation format — if `search_notes("STOP taking")` returns a hit, do a Pass 3 full read of that note to see which drugs are listed for discontinuation
- Look for any note that contradicts `ACTIVE_AT_LIVER_INJURY` (e.g., drug held clinically but flag=1)

### Common mistakes
- **Treating `ACTIVE_AT_LIVER_INJURY=1` as "drug continued"**: this flag only means active at T0. If the drug stopped LATER (e.g., end_day=+46), dechallenge IS assessable — use D_stop = end_day. "Drug continued" only applies when the drug was never stopped.
- Peak = all post-T0 max: wrong — peak is capped at drug stop date (for drug stopped after onset).
- Assuming T0 value is the peak when drug stopped before onset: always scan the full post-stop series — a later value may be higher.
- Counting days from T0 instead of from drug stop: dechallenge window starts at drug stop.
- **Picking an arbitrary follow-up value instead of the nadir**: the % decrease is (peak − MIN value in window) / peak. Scan every value in the window — a later value may be lower than the one you first looked at.
- **Skipping bilirubin for cholestatic/mixed**: the guideline says "ALP or total bilirubin" — check BOTH and use whichever gives the better score. Do not skip bilirubin just because ALP is available.
