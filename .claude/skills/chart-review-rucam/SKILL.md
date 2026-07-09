---
name: chart-review-rucam
description: >
  Score RUCAM (Roussel Uclaf Causality Assessment Method) for drug-induced
  liver injury (DILI) from EHR structured data + clinical notes. Triggers on:
  RUCAM, DILI causality, drug-induced liver injury, hepatotoxicity, R ratio,
  time to onset, rechallenge, liver injury scoring.
---

# Procedure

RUCAM has **7 scored items** whose scores sum to a total that maps to a causality
category (highly probable / probable / possible / unlikely / excluded).

**You do NOT score the items.** You **extract the small components** each item is
built from; the platform derives every item score, the total, and the category
deterministically from your components. Never call `set_field_assessment` on an
`item_*`, `rucam_total_score`, or `rucam_causality_category` field — those are
computed. `list_criteria` shows you exactly the component (leaf) fields to answer.

Several components/items depend on **injury type** (hepatocellular / cholestatic /
mixed) from the **R ratio** (ALT/ULN ÷ ALP/ULN) — extract that first.

Per-item logic (which component values map to which score) lives in
`references/scoring/item-N-*.md` — consult it for context, but commit the
**components**, not the score.

## Tools

- **Structured data (RUCAM plugin):** `get_patient_summary`, `get_suspect_drug`,
  `get_medications`, `get_drug_episodes` (45-day-gap merge), `get_lft_series`,
  `get_lab_extremum`, `get_serology`, `get_conditions`,
  `get_hepatotoxicity_category`, `compute_r_ratio`. The patient (`person_id`) and
  data dir are pre-bound — call these WITHOUT `person_id`/`data_dir`.
- **Notes:** `list_notes` / `read_note` (concur MCP, faithfulness-gated).
- **Write:** one `set_field_assessment` per **component** below (with a brief
  rationale + evidence); `set_review_status` when every applicable component is done.

## Components to extract

Read each field's criterion (`read_criterion` / `list_criteria`) for its exact
allowed values and evidence rules, then commit it. Grouped by the item it feeds:

**Injury type (feeds items 1–3)**
- `injury_track` — from `compute_r_ratio` (hepatocellular / cholestatic / mixed).

**Item 1 · time to onset**
- `onset_path` — initial_treatment / re_exposure / from_cessation / not_calculable (`get_drug_episodes`).
- `onset_latency_days` — integer days (drug-start→injury for path A; stop→injury for path B).

**Item 2 · course after stopping**
- `dechallenge_outcome` — the anchor lab's course after the drug stopped (`get_lab_extremum`).

**Item 3 · risk factors**
- `rf_alcohol`, `rf_pregnancy`, `rf_age_ge_55` — each yes / no.

**Item 4 · concomitant drugs**
- `concomitant_worst_timing` — suggestive / compatible / incompatible / none.
- `concomitant_worst_hepatotoxic` — yes / no (`get_hepatotoxicity_category` on the worst co-drug).
- `concomitant_attribution` — yes / no (is a co-drug clearly the cause?).

**Item 5 · exclusion of other causes** — one flag per cause, `yes` only if ruled out
by a negative test **or** an explicit note exclusion (per `references/scoring/item-5-exclusion.md`):
- Group I (6): `g1_hav_ruled_out`, `g1_hbv_ruled_out`, `g1_hcv_ruled_out`, `g1_biliary_obstruction_ruled_out`, `g1_alcoholism_ruled_out`, `g1_ischemia_ruled_out`.
- Group II (5): `g2_autoimmune_ruled_out`, `g2_sepsis_ruled_out`, `g2_chronic_hbv_hcv_ruled_out`, `g2_pbc_psc_ruled_out`, `g2_cmv_ebv_hsv_ruled_out`.
- `alt_cause_explains` — yes / no (does a non-drug cause sufficiently explain the injury? the −3 override).

**Item 6 · prior hepatotoxicity**
- `hepatotoxicity_class` — labeled / probable / none (`get_hepatotoxicity_category` on the suspect drug).

**Item 7 · rechallenge**
- `rechallenge_result` — positive_alone / positive_with_codrug / below_uln / none_or_insufficient.

## Steps

1. Read `references/scoring/item-0-setup.md`; call `compute_r_ratio` and commit `injury_track`.
2. Work through the components above, gathering evidence with the tools (+ notes) and
   committing each via `set_field_assessment`. Answer **every** applicable component —
   for the Group I/II exclusion flags, that means one flag per cause even when a cause
   was not assessed (`no`), because a missing flag leaves item 5 Pending.
3. `set_review_status` when done. The item scores, total, and category compute
   automatically from your components.
