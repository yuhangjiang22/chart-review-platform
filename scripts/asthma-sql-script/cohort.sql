-- ============================================================================
-- Asthma Adherence Cohort — pediatric (ages 2–17) with active asthma diagnosis
--
-- Identifies patients eligible for the asthma-adherence chart review study.
-- Result CSV feeds omop_etl.py which runs the per-patient extracts in
-- extracts.sql against each row.
--
-- Inclusion:
--   I1. ≥1 condition_occurrence mapped to "Asthma" SNOMED (317009) or
--       descendants, inside the study window.
--   I2. Age 2–17 (inclusive) at index_date.
--   I3. ≥2 outpatient/specialty visit_occurrences in the lookback window
--       (so the chart can support longitudinal adherence assessment).
--
-- Exclusion:
--   E1. Death before index_date.
--   E2. <1 year of observation prior to index_date (insufficient lookback
--       to assess controller adherence / SABA overuse).
--
-- Index date = FIRST asthma condition_occurrence inside the study window
--              that satisfies I2 and I3.
--
-- Parameters (set per site):
--   @cdmDatabaseSchema   — OMOP CDM schema (e.g., "omop_cdm")
--   @studyStartDate      — '2023-01-01'  (cohort entry window start)
--   @studyEndDate        — '2025-12-31'  (cohort entry window end)
--   @minAge / @maxAge    — 2 / 17
--   @lookbackDays        — 365
--   @minOutpatientVisits — 2
--
-- SQL flavor: T-SQL (SQL Server). For Postgres/Snowflake, run through
-- OHDSI SqlRender or port DATEDIFF/DATEADD by hand.
-- ============================================================================

WITH asthma_concepts AS (
  -- Standard concept set: SNOMED "Asthma" (317009) + all descendants.
  -- ICD-10-CM J45.x rows automatically map in via concept_relationship
  -- 'Maps to' → standard SNOMED concept_id.
  SELECT descendant_concept_id AS concept_id
  FROM @cdmDatabaseSchema.concept_ancestor
  WHERE ancestor_concept_id = 317009
),

asthma_dx AS (
  -- All asthma diagnosis events inside the study window.
  SELECT
    co.person_id,
    co.condition_start_date AS dx_date,
    co.condition_concept_id,
    ROW_NUMBER() OVER (
      PARTITION BY co.person_id
      ORDER BY co.condition_start_date ASC
    ) AS dx_rn
  FROM @cdmDatabaseSchema.condition_occurrence co
  INNER JOIN asthma_concepts ac
    ON co.condition_concept_id = ac.concept_id
  WHERE co.condition_start_date BETWEEN @studyStartDate AND @studyEndDate
),

first_dx AS (
  -- Candidate index = first asthma dx in the window.
  SELECT person_id, dx_date AS index_date
  FROM asthma_dx
  WHERE dx_rn = 1
),

age_check AS (
  -- Age at index date in years (SQL Server flavor).
  SELECT
    f.person_id,
    f.index_date,
    p.gender_concept_id,
    DATEDIFF(YEAR, CAST(p.birth_datetime AS DATE), f.index_date)
      - CASE
          WHEN DATEADD(YEAR,
                 DATEDIFF(YEAR, CAST(p.birth_datetime AS DATE), f.index_date),
                 CAST(p.birth_datetime AS DATE)) > f.index_date
          THEN 1 ELSE 0
        END AS age_at_index
  FROM first_dx f
  INNER JOIN @cdmDatabaseSchema.person p
    ON p.person_id = f.person_id
),

observation_check AS (
  -- I/E combined: patient must have observation_period covering the
  -- full lookback window (≥365d before index_date).
  SELECT a.*
  FROM age_check a
  INNER JOIN @cdmDatabaseSchema.observation_period op
    ON op.person_id = a.person_id
   AND op.observation_period_start_date <= DATEADD(DAY, -@lookbackDays, a.index_date)
   AND op.observation_period_end_date   >= a.index_date
  WHERE a.age_at_index BETWEEN @minAge AND @maxAge
),

outpatient_visits AS (
  -- Outpatient visits in the lookback window.
  -- 9202 = Outpatient Visit, 581477 = Office Visit, 5083 = Health examination,
  -- 38004250 = Telephone, 38004251 = Video.
  -- Adjust per site if you index different visit_concept_ids as "specialty".
  SELECT
    o.person_id,
    o.index_date,
    COUNT(DISTINCT v.visit_occurrence_id) AS n_outpt
  FROM observation_check o
  INNER JOIN @cdmDatabaseSchema.visit_occurrence v
    ON v.person_id = o.person_id
   AND v.visit_start_date BETWEEN
         DATEADD(DAY, -@lookbackDays, o.index_date) AND o.index_date
   AND v.visit_concept_id IN (9202, 581477, 5083, 38004250, 38004251)
  GROUP BY o.person_id, o.index_date
),

eligible AS (
  -- Apply visit-count threshold + exclude deaths before index.
  SELECT
    o.person_id,
    o.index_date,
    o.age_at_index,
    o.gender_concept_id,
    ov.n_outpt
  FROM observation_check o
  INNER JOIN outpatient_visits ov
    ON ov.person_id = o.person_id
   AND ov.index_date = o.index_date
  LEFT JOIN @cdmDatabaseSchema.death d
    ON d.person_id = o.person_id
  WHERE ov.n_outpt >= @minOutpatientVisits
    AND (d.death_date IS NULL OR d.death_date > o.index_date)
)

SELECT
  person_id,
  index_date,
  age_at_index,
  gender_concept_id,
  n_outpt
FROM eligible
ORDER BY person_id;
