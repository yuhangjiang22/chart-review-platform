# Asthma Adherence — portable OMOP extraction (OHDSI SqlRender)

Turns any site's OMOP CDM into the platform-shaped corpus the chart-review agents
read. Written as **OHDSI SqlRender source SQL** so it translates to any SQL dialect;
validated end-to-end against the real **RDRP-6745** (Indiana HIE / INPC) delivery.

## Files
| File | Purpose |
|---|---|
| `cohort.sql` | **Portable, OHDSI SQL.** Eligibility, and the one file that must be byte-identical across sites — who is in the denominator cannot be a local decision. SNOMED 317009 asthma; age 2–17 at index; index = most recent pediatric OUTPATIENT visit (9202); ≥ `@min_asthma_encounters` asthma-related non-inpatient encounters in the 12-month lookback with at least one non-ED; ≥ `@min_prior_observation_days` of prior observation; ≥ `@min_notes_12mo` notes in the lookback. Params: `@cdm_database_schema`, `@min_age`, `@max_age`, `@min_asthma_encounters`, `@min_prior_observation_days`, `@min_notes_12mo`, `@study_start`, `@study_end`. Read its header for the reasoning behind each. |
| `extracts.sql` | **Portable, OHDSI SQL.** Flat per-table SELECTs (conditions, drugs→ingredient, asthma_visits, encounters, measurements, procedures, notes) joined to the cohort table. |
| `conformance.sql` | **Portable, OHDSI SQL.** Six pre-flight checks — run FIRST. They report which of your site's data dimensions are populated well enough for the questions that depend on them. |
| `adapter_rdrp.sql` | **Site-specific.** The ONLY file you replace per site: maps RDRP CSV/parquet → standard OMOP view names. A standard warehouse points `@cdm_database_schema` at its CDM instead. |
| `etl.py` | Runner: renders the SQL, runs it, applies the Python transform (drug fills, foundations, `asthma_related`, salted-hash anonymize), writes `corpus/patients/<anon>/`. Also `--check` (conformance). |
| `derive_anchors.py` | Derives the four event-anchor lists (`asthma_encounters`, `ocs_bursts`, `exacerbations`, `obligation_points`) from the per-patient OMOP JSON the ETL just wrote. Called by `etl.py`; also runnable standalone over an existing corpus. The event-level rules are enumerated from these, so their definitions are part of the measurement. |
| `test_derive_anchors.py`, `test_roll_up_drugs.py` | `pytest`. Cover the anchor derivations and the 12-month drug fields (window boundaries, SABA counting basis, days_supply completeness). Run them after touching either file. |
| `screen_v05.py` | One-off cohort screening helper. Not part of the extraction path. |

## Comparability across sites

Each site has its own patients, so the *records* are never the same. What is the
same — by construction, not by hope — is the **cohort definition and the
extraction logic**: `cohort.sql`, `extracts.sql` and `conformance.sql` are shared
and must not be edited per site. Only two things are allowed to vary:

1. **Where the data lives.** Everything site-specific is isolated in one adapter
   file that maps the site's tables to standard OMOP view names.
   `adapter_rdrp.sql` is the reference implementation; a standard warehouse can
   often just point `@cdm_database_schema` at its CDM instead.
2. **The parameters.** `@min_notes_12mo` in particular is set per site, because
   note volume in OMOP differs by an order of magnitude between a hospital CDM
   and an HIE.

**Dialect** is handled by writing the SQL as OHDSI SqlRender source (standard
`@`-params, `DATEADD`/`YEAR`, no dialect-specific syntax), so a site renders it
for its own database:

```r
SqlRender::translate(
  SqlRender::render(readr::read_file("cohort.sql"),
    cdm_database_schema="omop_cdm", min_age=2, max_age=17,
    min_asthma_encounters=2, min_prior_observation_days=365, min_notes_12mo=0,
    study_start="2021-01-01", study_end="2100-01-01"),
  targetDialect="postgresql")   # or 'sql server','bigquery','redshift','spark',…
```

`etl.py` ships a **DuckDB render stand-in** (`render_duckdb`) so this repo can be
validated against the RDRP files; **at your site use real OHDSI SqlRender**, not
the stand-in.

### What genuinely differs, and how it is measured

Identical logic over differently-populated data does not produce identical
corpora, and that is the part worth being concrete about rather than assuming
away. Observed so far: RDRP-6745 has `days_supply` null on every one of 6,653
drug fills and no structured ACT at all; another site has no
`observation_period` table. Each of those changes what some question can be
answered from.

`conformance.sql` exists to surface exactly this before any extraction runs — six
checks, reported as PASS / WARN / FAIL, with the WARNs naming which downstream
value degrades. Run it first, keep its output, and send it with the results: a
rate is only comparable next to the population facts behind it.

## Conformance check (run this first)
```
python3 etl.py --check --rdrp <RDRP-6745> --notes "<RDRP-6745 Notes>"
```
On RDRP-6745 it reports (illustrative of what it catches):
| check | RDRP value | status | meaning |
|---|---|---|---|
| asthma_concepts | 117 | PASS | vocabulary resolves SNOMED 317009 |
| visit_mapping_pct | 98.7 | PASS | visits mapped to 9201/9202/9203 |
| notes_populated | 2,569,604 | PASS | note text present |
| days_supply_pct | 43.2 | WARN | <50% → `refill_pdc_12mo` is a floor, not a rate; each affected drug row carries `refill_pdc_partial` (SABA count unaffected — it counts fills) |
| act_structured | 0 | WARN | ACT is note-only here (typical of an HIE) |
| drug_ingredient_rollup | 1,309 | PASS | drugs roll up to RxNorm ingredients |

A WARN doesn't block extraction — it flags a dimension where your site differs, which
Paper-1 must account for (the design's HIE-completeness caveat).

## Extraction
```
pip install duckdb
python3 etl.py --rdrp <RDRP-6745> --notes "<RDRP-6745 Notes>" \
        --out corpus/patients --limit 25      # omit --limit for the whole cohort
```
Writes `corpus/patients/<patient_real_asthma_HASH>/{meta.json, omop/*.json, notes/*.txt}`.
`person_id` is salted-hash anonymized (`--salt`); output ids use the gitignored
`patient_real_*` prefix (PHI stays local). Only SQL/config travels between sites — no PHI.

## Validation — RDRP-6745 (real site, via the DuckDB stand-in)
Run against RDRP-6745 (via the DuckDB stand-in): cohort = **57,235** eligible pediatric-
asthma patients — measured BEFORE the prior-observation floor, the study window and the
asthma-linked-encounter definition were added, so read it as an upper bound on the
current criteria rather than as today's number.

The full rendered ETL reproduces the two hand-built fixtures **exactly** on every field
— conditions, encounters + `asthma_related`, `age_band`, `controller_active`,
`lookback_outpatient_count_12mo`, `saba_canisters_12mo`, `exacerbations_12mo`, notes:
```
patient_real_asthma_01: ALL MATCH ✓  age_band=age_12_17 lb=9 saba=14 exac=2 conds=17 enc=26 ar=22 notes=25
patient_real_asthma_03: ALL MATCH ✓  age_band=age_5_11  lb=3 saba=0  exac=1 conds=13 enc=21 ar=11 notes=24
```

## Cross-site portability — a second, synthetic OMOP site (also via the stand-in)
The identical `cohort.sql` / `extracts.sql` / `conformance.sql` were run against a
**synthetic standard-OMOP site** (different patients, standard column names, a
populated `note` table, and `days_supply` present) by swapping ONLY the adapter
(`adapter_synthetic.sql`). Result: conformance PASSES all 6 checks (vs RDRP's 2 WARNs),
and extraction produced correct corpora across all three age bands — exercising the
paths RDRP can't: `refill_pdc_12mo` computes (0.99 / 0.16), ACT comes from the
measurement table, and notes come from the OMOP `note` table. So the portable SQL runs
unchanged where RDRP's quirks don't exist.

Both runs used the DuckDB stand-in to render the SQL. A first run through real OHDSI
SqlRender against a live CDM is what the WCM pilot adds.

## RDRP real-data adaptations (documented in `adapter_rdrp.sql`)
Composite `CONDITION_SOURCE_VALUE` (`1284^^J45.50^`) → `icd10cm` regex-parsed (cohort
matches the standard `condition_concept_id`, not the composite); notes as parquet →
mapped to the `note` view; `DAYS_SUPPLY` absent → `refill_pdc_12mo` is computed from whatever fills carry one and
each affected drug row is flagged `refill_pdc_partial` (a floor, not a rate); the SABA
count is unaffected because it counts dispensings; year-precision age.
