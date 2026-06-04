# Asthma Adherence — OMOP SQL Scripts

End-to-end pipeline that turns a source OMOP CDM into the platform-shaped
JSON files the chart-review agents read. Designed for cross-site cohort
coordination (e.g., IU + Cornell) where both sites need to produce a
comparable patient corpus from their own EHR data warehouses.

## Files

| File | Purpose |
|---|---|
| `cohort.sql` | Identifies the study cohort per the protocol's Cohort Definition. Pediatric (ages 2–17) at index_date, active asthma diagnosis (SNOMED 317009 + descendants, which includes ICD-10 J45.x), ≥2 asthma-related encounters anywhere in the study window, alive at index, no primary diagnosis of cystic fibrosis / bronchiectasis / bronchopulmonary dysplasia (chronic lung disease that would confound asthma management). Returns one row per eligible patient with `(person_id, index_date, age_at_index, gender_concept_id, n_asthma_encounters)`. |
| `extracts.sql` | The six per-patient queries (`conditions`, `drug_regimens` + `drug_fills` + `drug_sig`, `measurements`, `observations`, `procedures`, `encounters`). Each section is delimited by a `-- ==NAME foo==` marker so `omop_etl.py` can load them by name. Result sets serialize 1:1 into the JSON shapes the platform's `read_structured_data` MCP tool consumes. |
| `omop_etl.py` | Python wrapper. Reads the cohort CSV, runs the 6 extracts per patient, aggregates drug fills into the platform's nested shape, computes `refill_pdc_12mo` (HEDIS MAM-style) and `saba_canisters_12mo`, anonymizes `person_id` with a site-prefixed salted hash, and writes the full `corpus/patients/<anon_id>/` layout. |

## How to run

```bash
# 1. Cohort identification — run cohort.sql against your CDM,
#    export to CSV with columns:
#    person_id, index_date, age_at_index, gender_concept_id, n_asthma_encounters
#
#    Example (SQL Server):
sqlcmd -S host -d omop_prod -i cohort.sql -o cohort.csv

# 2. Per-patient extraction — install deps and set env:
pip install 'sqlalchemy>=2.0' 'pandas>=2.0' pyodbc   # or psycopg2, snowflake-sqlalchemy
export DATABASE_URL='mssql+pyodbc://user:pass@host/db?driver=ODBC+Driver+17'
export ANON_SALT='shared-secret-between-sites-2026'  # SAME at every site

python omop_etl.py \
    --cohort-csv cohort.csv \
    --site-prefix iu \
    --output-dir ./corpus/patients \
    --schema omop_cdm \
    --lookback-days 365
```

Output layout per patient:

```
corpus/patients/<anon_id>/
├── meta.json                       demographics, index_date, lookback
├── omop/
│   ├── conditions.json
│   ├── drugs.json                  with fills[], refill_pdc_12mo, saba_canisters_12mo
│   ├── measurements.json
│   ├── observations.json
│   ├── procedures.json
│   └── encounters.json
└── _manifest.json                  (parent dir) — anon_id → row counts per site
```

Anonymized IDs look like `iu_a3f2c91e88` (site_prefix + 10-char SHA-256 of
`{salt}:{person_id}`). Idempotent across re-runs.

## Cross-site contracts

Three lookup tables are NOT part of OMOP; both sites MUST agree on them
before running:

1. **`DRUG_CLASS_MAP`** (in `omop_etl.py`, ~line 50) — maps RxNorm
   ingredient `concept_id` to the platform's drug class buckets (ICS,
   ICS-LABA, LTRA, biologic, SABA, LAMA, OCS). 18 ingredients covered
   today; add others by appending to the dict.
2. **LOINC allowlist** (in `extracts.sql`, `measurements` section) —
   which lab/instrument codes to extract. Currently: ACT score
   (75827-3), FEV1/FVC (19926-5), FEV1 % predicted (33452-4), FEV1
   (20150-9), FVC (19868-9), FeNO (76270-8), BMI (39156-5).
3. **Observation concept allowlist** (in `extracts.sql`, `observations`
   section) — which `observation_concept_id` values to extract. Local
   site concepts may differ; verify with `SELECT * FROM concept WHERE
   concept_id IN (...)` before running on real data.

## SQL flavor

The SQL is T-SQL (SQL Server) flavored: `DATEDIFF`, `DATEADD`,
`SELECT TOP 1`, `VARCHAR(40)`, `prov.last_name + ', ' + prov.first_name`.
For Postgres / Snowflake, either run through OHDSI `SqlRender` or port
the ~8 date arithmetic / string concat sites by hand.

## What's NOT in this pipeline

- **Note text extraction.** The platform also reads
  `corpus/patients/<anon_id>/notes/*.txt`. Without notes the agents can
  answer ~9 of the 16 questions; the qualitative T2 questions
  (WrittenActionPlan, InhalerTechniqueChecked, ComorbidityAddressed,
  ContraindicationDocumented) degrade significantly. Notes extraction +
  de-identification (Philter, MS PII detector, or local) is a separate
  pipeline; deciding the de-id approach is the prerequisite, not the code.
- **Provider PII scrubbing.** `encounters.json` carries
  `primary_provider` and `care_site_name`. If those are real names (not
  de-identified providers), strip or hash them in `to_jsonable` before
  sharing between sites.
- **Drift between vocabulary releases.** `concept_ancestor` results
  differ slightly across OMOP Vocabulary versions. For comparability,
  both sites should pin to the same release (e.g., 2023Q4).

## Validation before running on a full cohort

```bash
# Run on 2-3 rows first to catch concept-ID mismatches loudly.
head -4 cohort.csv > cohort_smoke.csv
python omop_etl.py --cohort-csv cohort_smoke.csv \
    --site-prefix iu --output-dir ./smoke
```

Then inspect `smoke/<anon_id>/omop/*.json` and confirm shapes match a
known-good demo patient under `corpus/patients/patient_demo_asthma_01/`.
