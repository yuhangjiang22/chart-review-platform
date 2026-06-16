---
name: chart-review-rucam
description: >
  Score RUCAM (Roussel Uclaf Causality Assessment Method) items for drug-induced
  liver injury (DILI) from EHR structured data + clinical notes. Triggers on:
  RUCAM, DILI causality, drug-induced liver injury, hepatotoxicity, R ratio,
  time to onset, rechallenge, liver injury scoring.
---

# Procedure

RUCAM scores **7 items**; the per-item scores sum to a total that maps to a
causality category (highly probable / probable / possible / unlikely /
excluded). Several items are scored differently by **injury type**
(hepatocellular / cholestatic / mixed), which comes from the **R ratio**
(ALT/ULN ÷ ALP/ULN).

Per-item scoring logic lives in `references/scoring/item-N-*.md` — **read the
item file before scoring that item.**

## Tools

- **Structured data (RUCAM plugin):** `get_patient_summary`, `get_suspect_drug`,
  `get_medications`, `get_drug_episodes` (45-day-gap merge), `get_lft_series`,
  `get_lab_extremum`, `get_serology`, `get_conditions`,
  `get_hepatotoxicity_category`, `compute_r_ratio`. The patient (`person_id`) and
  data dir are pre-bound — call these tools WITHOUT `person_id`/`data_dir`.
- **Notes:** `list_notes` / `read_note` (concur MCP, faithfulness-gated).
- **Write:** one `set_field_assessment` per item criterion (the item's integer
  score); `set_review_status` when done. The total + category are derived — do
  NOT set them.

## Steps

1. Read `references/scoring/item-0-setup.md`, then call `compute_r_ratio` to get
   the injury type — it gates several items.
2. For each item 1–7: read `references/scoring/item-N-*.md`, gather evidence with
   the tools above (+ notes), then `set_field_assessment` that item's integer
   score with a brief rationale.
3. Stop. `rucam_total_score` (sum of items) and `rucam_causality_category`
   (bucketed total) are computed.
