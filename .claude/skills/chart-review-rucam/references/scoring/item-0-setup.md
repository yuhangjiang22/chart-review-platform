# Item 0 — Eligibility Setup (run before every item)

> **DECOMPOSED TASK — READ FIRST.** You do **not** compute or commit RUCAM item
> scores. For each of the 7 items you extract its **components** (small factual
> leaves) and commit those with `set_field_assessment`; the platform derives
> `item_1…item_7`, `rucam_total_score`, and `rucam_causality_category`
> deterministically from your components. **Never** call `set_field_assessment`
> on an `item_*`, `rucam_total_score`, or `rucam_causality_category` field — those
> are computed and any value you write there is discarded. Each `item-N-*.md`
> file below tells you how to gather the data and ends with the exact component
> field(s) to commit; read each field's criterion (`read_criterion`) for its
> allowed values. The old per-item scoring tables now live inside the platform's
> derivation — they have been removed from these files on purpose.

**Goal:** Confirm the episode is scoreable and establish the correct track.

### Step 1 — Verify liver injury at T0
- `get_lft_series(day_min=-7, day_max=7)` → check ALT/AST at `liver_injury_date`
- **Eligibility criterion: ALT or AST ≥ 5×ULN** — use per-row `ULN` from the lab series; if missing, fall back to default ALT ULN=52 (AST ULN similar)
- Search notes for earlier dates where this criterion was already met
- If notes show earlier injury onset, document it — but keep `liver_injury_date` as the primary analysis date

### Step 2 — Record onset labs
- Record ALT, ALP, and their ULNs at T0 (used to confirm R ratio)
- R ratio = (ALT/ALT_ULN) ÷ (ALP/ALP_ULN) — use per-row ULN from data; defaults ALT_ULN=52, ALP_ULN=125 only if not provided
- Confirm the R value matches the `injury_type` in the task prompt (pre-computed; do not recompute)

### Step 3 — Confirm suspect drug
- `get_suspect_drug` → confirm `SELECTED_DRUG` identity, `CODE`, `FIRST_DATE`

### Step 4 — Commit the track component
→ **Commit `injury_track`** = `hepatocellular` / `cholestatic` / `mixed`, matching
the pre-computed `injury_type` in the task prompt (R ratio: hepatocellular R ≥ 5,
cholestatic R ≤ 2, mixed 2 < R < 5). Several items' derivations branch on this, so
extract it first. Do **not** compute any item score here.
