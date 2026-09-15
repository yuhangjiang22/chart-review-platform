# Item 0 — Eligibility Setup (run before every item)

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
