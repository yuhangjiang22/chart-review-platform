# Asthma Adherence — portable OMOP extraction (OHDSI SqlRender)

Turns any site's OMOP CDM into the platform-shaped corpus the chart-review agents
read. Written as **OHDSI SqlRender source SQL** so it translates to any SQL dialect;
validated end-to-end against the real **RDRP-6745** (Indiana HIE / INPC) delivery.

## Files
| File | Purpose |
|---|---|
| `cohort.sql` | **Portable, OHDSI SQL.** Eligibility: SNOMED 317009 asthma, age 2–17 at index, index = most-recent pediatric outpatient visit, ≥2 outpatient visits in the 12-mo lookback. `@cdm_database_schema`, `@min_age`, `@max_age`, `@min_lookback_visits`. |
| `extracts.sql` | **Portable, OHDSI SQL.** Flat per-table SELECTs (conditions, drugs→ingredient, asthma_visits, encounters, measurements, procedures, notes) joined to the cohort table. |
| `conformance.sql` | **Portable, OHDSI SQL.** Pre-flight checks — run FIRST to see if your site will produce comparable data. |
| `adapter_rdrp.sql` | **Site-specific.** The ONLY file you replace per site: maps RDRP CSV/parquet → standard OMOP view names. A standard warehouse points `@cdm_database_schema` at its CDM instead. |
| `etl.py` | Runner: renders the SQL, runs it, applies the Python transform (drug fills, foundations, `asthma_related`, salted-hash anonymize), writes `corpus/patients/<anon>/`. Also `--check` (conformance). |

## Can another site get comparable data? — the honest answer
**Not the same *records*** (each site has its own patients) — the **same cohort
definition + extraction logic**, applied to each site's data. Portability rests on
three things, all now addressed:

1. **Dialect** — `cohort.sql` / `extracts.sql` / `conformance.sql` are OHDSI SqlRender
   source (standard schema `@`-params, `DATEADD`/`YEAR`, no dialect-specific syntax).
   A site renders them with real OHDSI SqlRender:
   ```r
   SqlRender::translate(
     SqlRender::render(readr::read_file("cohort.sql"),
       cdm_database_schema="omop_cdm", min_age=2, max_age=17, min_lookback_visits=2),
     targetDialect="postgresql")   # or 'sql server','bigquery','redshift','spark',…
   ```
   `etl.py` ships a **DuckDB render stand-in** (`render_duckdb`) so we can validate on
   the RDRP files here; **at your site use OHDSI SqlRender**, not the stand-in.
2. **Warehouse specifics** — everything site-specific is isolated in
   `adapter_rdrp.sql`. Swap it for your CDM; the cohort/extracts are unchanged.
3. **Data-population reality** — the biggest driver of "same or not." Run
   `conformance.sql` first; it reports where your corpus will differ (and why).

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

## Validation (reproducible)
Run against RDRP-6745 (via the DuckDB stand-in): cohort = **57,235** eligible pediatric-
asthma patients. The full rendered ETL reproduces the two hand-built fixtures **exactly**
on every field — conditions, encounters + `asthma_related`, `age_band`, `controller_active`,
`lookback_outpatient_count_12mo`, `saba_canisters_12mo`, `exacerbations_12mo`, notes:
```
patient_real_asthma_01: ALL MATCH ✓  age_band=age_12_17 lb=9 saba=14 exac=2 conds=17 enc=26 ar=22 notes=25
patient_real_asthma_03: ALL MATCH ✓  age_band=age_5_11  lb=3 saba=0  exac=1 conds=13 enc=21 ar=11 notes=24
```

## Cross-site portability — tested on a second (synthetic) OMOP site
The identical `cohort.sql` / `extracts.sql` / `conformance.sql` were run against a
**synthetic standard-OMOP site** (different patients, standard column names, a
populated `note` table, and `days_supply` present) by swapping ONLY the adapter
(`adapter_synthetic.sql`). Result: conformance PASSES all 6 checks (vs RDRP's 2 WARNs),
and extraction produced correct corpora across all three age bands — exercising the
paths RDRP can't: `refill_pdc_12mo` computes (0.99 / 0.16), ACT comes from the
measurement table, and notes come from the OMOP `note` table. This proves the portable
SQL runs unchanged where RDRP's quirks don't exist.

## Remaining limitation (stated plainly)
Validated on ONE real site (RDRP-6745) + ONE synthetic standard-OMOP site, both via the
DuckDB SqlRender stand-in. The final production proof is a run against a **real second
site's live CDM** (e.g. WCM) through **real OHDSI SqlRender** — not yet done. The
conformance check is the tool a new site uses to gauge readiness before that run.

## RDRP real-data adaptations (documented in `adapter_rdrp.sql`)
Composite `CONDITION_SOURCE_VALUE` (`1284^^J45.50^`) → `icd10cm` regex-parsed (cohort
matches the standard `condition_concept_id`, not the composite); notes as parquet →
mapped to the `note` view; `DAYS_SUPPLY` absent → PDC skipped; year-precision age.
