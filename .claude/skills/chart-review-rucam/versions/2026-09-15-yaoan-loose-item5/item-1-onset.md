# Item 1 — Time to Onset

**Goal:** Determine whether the time between drug exposure and liver injury is consistent with DILI.

### Step 1 — Gather suspect drug identity
- `get_suspect_drug` → `FIRST_DATE`, `CODE`, `SELECTED_DRUG`
- Liver injury date (T0) is provided in the task prompt

### Step 2 — Get merged exposure episodes — use `get_drug_episodes`
Call `get_drug_episodes(drug_name=<SELECTED_DRUG>, drug_code=<CODE if not null>)`. The tool handles:
- Drug name matching (case-insensitive substring on DRUG_NAME, exact match on DRUG_CODE)
- Combination drugs (splits on `/`, e.g. 'Sulfamethoxazole/Trimethoprim' matches either component)
- end_date computation (STOP_DATE if present, else START_DATE + DAYS_SUPPLY_VAL)
- 45-day gap rule: fills with gap ≤ 45 days merge into one continuous episode (initial treatment); gap > 45 days starts a new episode (re-exposure)

Returns a list of episodes, each with `start_date`, `end_date`, `start_day`, `end_day`, `n_fills`, and `relative_to_t0` (`ongoing_at_t0` / `stopped_before` / `started_after`).

### Step 3 — Pick the relevant episode and choose path
Pick the episode containing T0 (`ongoing_at_t0`); if none, pick the most recent `stopped_before` episode.

**Path A (onset-from-start):** Episode `relative_to_t0 == "ongoing_at_t0"` (end_day ≥ 0)
- Latency = `-start_day` (days from episode start to T0)
- `n_fills > 1` (multiple merged fills) = initial treatment continuation — still Path A initial treatment
- A second `ongoing_at_t0` episode with an earlier `stopped_before` episode (gap > 45 days) = re-exposure

**Path B (onset-from-cessation):** Episode `relative_to_t0 == "stopped_before"` (end_day < 0)
- Latency = `-end_day` (days from drug stop to T0)

**NOT CALCULABLE (scoreable=False):** All episodes are `started_after` (reaction before drug started)

### Step 4 — Score by track

**Hepatocellular (R > 5):**
| Path | Latency | Score |
|---|---|---|
| A, initial treatment | 5–90 days | +2 |
| A, initial treatment | <5 or >90 days | +1 |
| A, re-exposure | 1–15 days | +2 |
| A, re-exposure | >15 days | +1 |
| B | ≤15 days | +1 |
| B | >15 days | NOT CALCULABLE |

**Cholestatic/Mixed (R ≤ 5):**
| Path | Latency | Score |
|---|---|---|
| A, initial treatment | 5–90 days | +2 |
| A, initial treatment | <5 or >90 days | +1 |
| A, re-exposure | 1–90 days | +2 |
| A, re-exposure | >90 days | +1 |
| B | ≤30 days | +1 |
| B | >30 days | NOT CALCULABLE |

### Note review — Item 1
- Search notes for drug start/stop dates that may differ from structured data
- Keywords: drug name, "started", "initiated", "stopped", "discontinued", "held"
- **If notes show the drug still on medication lists after the structured STOP_DATE**, document the conflict and reconcile per the global rule (aggregate all sources, explain which you relied on and why).

### Common mistakes
- Confusing initial vs re-exposure: `get_drug_episodes` handles this for you — one episode with `n_fills > 1` is initial treatment continuation, two separate episodes is re-exposure.
- Building episodes manually from `get_medications`: use `get_drug_episodes` instead — it applies the 45-day gap rule, DAYS_SUPPLY_VAL fallback, and combination-drug splitting deterministically.
- Ignoring Path B: if the relevant episode is `stopped_before`, do NOT default to Path A.
- Search for alternative suspect drug: Do not search for an alternative suspect drug if no suspect drug is provided. If no suspect drug is available, mark the case as `NOT CALCULABLE`.
