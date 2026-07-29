/*********************************************************************************
* cohort.sql — Pediatric asthma adherence cohort  (OHDSI SQL / SqlRender source)
*
* Render for YOUR dialect with OHDSI SqlRender, e.g. (R):
*   SqlRender::render(sql, cdm_database_schema='omop_cdm', min_age=2, max_age=17,
*                     min_lookback_visits=2)  |>
*   SqlRender::translate(targetDialect='postgresql')   # or 'sql server','bigquery',
*                                                       # 'redshift','spark','duckdb'
*
* Portable: only standard OMOP tables + standard concept sets (SNOMED 317009 via
* concept_ancestor; standard visit_concept_id 9202). No dialect-specific syntax —
* date math uses SqlRender's DATEADD/YEAR (translated per dialect).
*
* Definition (matches the study Cohort Definition + v0.4 T0-LookbackHasNotes):
*   - Asthma: condition_concept_id IN descendants of SNOMED 317009 (ICD-10 J45.x
*     AND ICD-9 493.x map in via the standard concept — coding-scheme independent).
*   - index_date = most recent PEDIATRIC (age @min_age..@max_age) OUTPATIENT visit
*     (visit_concept_id = 9202). Outpatient-anchored so the lookback is populated.
*   - >= @min_lookback_visits outpatient visits in the 12 months before index.
*
* Emits one row per eligible patient. Age uses YEAR_OF_BIRTH (de-identified data
* is year-precision); a site with full birth_datetime can substitute exact age.
*********************************************************************************/

WITH asthma AS (
  SELECT descendant_concept_id AS cid
  FROM @cdm_database_schema.concept_ancestor
  WHERE ancestor_concept_id = 317009
),
asthma_pts AS (
  SELECT DISTINCT co.person_id
  FROM @cdm_database_schema.condition_occurrence co
  INNER JOIN asthma a ON co.condition_concept_id = a.cid
),
op AS (  -- outpatient visits (9202) with age at visit
  SELECT v.person_id,
         v.visit_start_date AS vdate,
         YEAR(v.visit_start_date) - p.year_of_birth AS age
  FROM @cdm_database_schema.visit_occurrence v
  INNER JOIN @cdm_database_schema.person p ON p.person_id = v.person_id
  WHERE v.visit_concept_id = 9202 AND v.visit_start_date IS NOT NULL
),
idx AS (  -- most recent pediatric outpatient visit, among asthma patients
  SELECT op.person_id, MAX(op.vdate) AS index_date
  FROM op
  INNER JOIN asthma_pts ap ON ap.person_id = op.person_id
  WHERE op.age BETWEEN @min_age AND @max_age
  GROUP BY op.person_id
),
idx_age AS (
  SELECT i.person_id, i.index_date,
         YEAR(i.index_date) - p.year_of_birth AS age_at_index
  FROM idx i
  INNER JOIN @cdm_database_schema.person p ON p.person_id = i.person_id
),
lookback AS (  -- >= N outpatient visits in the 12-mo window before index
  SELECT ia.person_id, COUNT(*) AS n_lookback_outpatient
  FROM idx_age ia
  INNER JOIN op ON op.person_id = ia.person_id
  WHERE op.vdate > DATEADD(MONTH, -12, ia.index_date)
    AND op.vdate <= ia.index_date
  GROUP BY ia.person_id
)
SELECT ia.person_id, ia.index_date, ia.age_at_index, lb.n_lookback_outpatient
FROM idx_age ia
INNER JOIN lookback lb ON lb.person_id = ia.person_id
WHERE ia.age_at_index BETWEEN @min_age AND @max_age
  AND lb.n_lookback_outpatient >= @min_lookback_visits
ORDER BY ia.person_id;
