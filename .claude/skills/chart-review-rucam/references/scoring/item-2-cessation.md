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
- Drug stopped **before** onset (D_stop < 0): `get_lab_extremum(lab_name=<anchor>, stat="max", day_min=D_stop+1, day_max=0)`

### Step 3 — Find the nadir in the dechallenge window — use `get_lab_extremum`
**Use the minimum anchor-lab value inside each applicable dechallenge window.** The window starts at the later of the drug stop date or T0. If the drug was stopped before liver injury onset, start at T0 so that pre-onset laboratory values are not included. Use the tool directly — do not scan the series manually.

Define:
- `W_start=max(D_stop+1, 0)`
Window (in days from T0, i.e. DAYS_FROM_LIVER_INJURY) for each scoring tier:
- Hepatocellular +3: `day_min=W_start, day_max=D_stop+8` → `get_lab_extremum("ALT","min",...)`
- Hepatocellular +2: `day_min=W_start, day_max=D_stop+30`
- Hepatocellular >30: `day_min=max(W_start, D_stop+1)` (no upper bound)
- Cholestatic/Mixed: `day_min=W_start, day_max=D_stop+180` (run once for ALP, once for bilirubin_total)

% decrease = (peak − nadir) / peak × 100. Compare to 50% threshold.

**Important:** The overall nadir may occur much later than the first value that reaches a ≥ 50% decrease. Use the minimum value to determine whether the threshold was reached within each window, but use the **earliest laboratory date within that window that meets the ≥ 50% threshold** to determine the outcome bucket.

**Worked example — D_stop before T0:** drug stopped 14 days before T0 (D_stop = −14).
D_stop+8 = −6 — before T0, so the 8-day window has no valid post-stop days and is
unreachable; do not fill it with a lab dated at/after T0. D_stop+30 = +16, so the
30-day window is `day_min=0, day_max=+16` — a lab on day+8 (relative to T0) belongs to
THIS window, not the 8-day one. When D_stop+8 (or D_stop+30) computes to a negative
number, skip that tier — check the next one.

### Step 4 — Commit the component (do NOT score)
From the peak → follow-up % decrease and the **earliest date on which a ≥ 50% decrease is reached** (measured from the drug stop date), determine ONE outcome bucket. If the drug was stopped before T0, begin evaluating the course at T0, but retain the drug stop date for determining the elapsed dechallenge interval. The platform's `item_2_course` derivation applies the track-specific score. For cholestatic/mixed, evaluate ALP and bilirubin separately and report the **best** qualifying bucket based on the earliest ≥ 50% decrease; if neither reaches 50%, use the larger observed decrease.

**Every nadir/follow-up lab you cite must have `days_from_injury > D_stop` — a lab
drawn while the drug was still active is not post-cessation evidence, however low the
value is.** If `get_drug_episodes` shows the suspect drug `ongoing_at_t0` with a large
positive `end_day`, your usable follow-up window starts AFTER that `end_day`, not at
T0 — do not substitute early post-injury labs (drawn while still on the drug) for
genuine post-stop follow-up. **Cite the `get_drug_episodes` result in your evidence
array whenever D_stop is not 0** — a peak/nadir lab citation alone, with no episode
citation backing D_stop, is not sufficient.

→ **Commit `dechallenge_outcome`** =
- `ge50_le8d` — ≥ 50% decrease first reached within 8 days of drug stop
- `ge50_le30d` — ≥ 50% decrease first reached within 30 days of drug stop, but not within 8 days
- `ge50_le180d` — ≥ 50% decrease first reached after 30 days but within 180 days of drug stop
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
- **Using pre-cessation labs (drawn while the drug was still active) as if they were post-stop improvement** — e.g. `get_drug_episodes` shows the drug `ongoing_at_t0` with `end_day=+84`, but the cited nadir lab is from day+7 (still on-drug). A lab must postdate D_stop to count.
- Computing D_stop+8 (or D_stop+30) without checking the sign — when D_stop is well before T0, that window can land in the past and is unreachable.
- **Picking an arbitrary follow-up value instead of the nadir**: the % decrease is (peak − MIN value in window) / peak. Scan every value in the window — a later value may be lower than the one you first looked at.
- **Skipping bilirubin for cholestatic/mixed**: the guideline says "ALP or total bilirubin" — check BOTH and use whichever gives the better score. Do not skip bilirubin just because ALP is available.
