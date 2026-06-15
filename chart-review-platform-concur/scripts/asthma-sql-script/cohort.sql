-- ============================================================================
-- Asthma Adherence Cohort — pediatric (ages 2–17) with active asthma diagnosis
--
-- Identifies patients eligible for the asthma-adherence chart review study.
-- Result CSV feeds omop_etl.py which runs the per-patient extracts in
-- extracts.sql against each row.
--
-- Criteria match the protocol's Cohort Definition document
-- (Cohort_Definition_Asthma_Adherence): pediatric scope, longitudinal
-- engagement, exclude confounding chronic lung disease.
--
-- Inclusion:
--   I1. ≥1 condition_occurrence mapped to "Asthma" SNOMED (317009) or
--       descendants, inside the study window — used as index_date.
--   I2. Age 2–17 (inclusive) at index_date.
--   I3. ≥2 asthma-related encounters (visit_occurrence rows linked to an
--       asthma diagnosis) anywhere in the study window — operationalizes
--       "longitudinal clinical notes available" from the protocol.
--
-- Exclusion:
--   E1. Death before index_date.
--   E2. Primary diagnosis of cystic fibrosis, bronchiectasis, or
--       bronchopulmonary dysplasia (confounding chronic lung disease).
--
-- Index date = FIRST asthma condition_occurrence inside the study window
--              that satisfies I2.
--
-- Parameters (set per site):
--   @cdmDatabaseSchema   — OMOP CDM schema (e.g., "omop_cdm")
--   @studyStartDate      — '2015-01-01'  (study window per protocol)
--   @studyEndDate        — '2026-12-31'
--   @minAge / @maxAge    — 2 / 17
--   @minAsthmaEncounters — 2
--
-- Notes:
--   - The protocol does NOT require continuous OMOP observability
--     (observation_period coverage) — that allows multi-site
--     participation including sites without the observation_period table.
--   - The chronic-lung-disease exclusion list below is the protocol's
--     explicit set (CF, bronchiectasis, BPD). Sites can extend by adding
--     ancestor concept_ids — coordinate before doing so.
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

confounding_concepts AS (
  -- Chronic lung diseases that confound asthma management assessment, per
  -- protocol: cystic fibrosis (4022127), bronchiectasis (4145497),
  -- bronchopulmonary dysplasia (312940). Plus their descendants.
  -- Verify against your local vocabulary release before running on real
  -- data; concept_ids can shift between OMOP Vocabulary versions.
  SELECT descendant_concept_id AS concept_id
  FROM @cdmDatabaseSchema.concept_ancestor
  WHERE ancestor_concept_id IN (4022127, 4145497, 312940)
),

asthma_dx AS (
  -- All asthma diagnosis events inside the study window.
  SELECT
    co.person_id,
    co.condition_start_date  AS dx_date,
    co.visit_occurrence_id,
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
  WHERE p.birth_datetime IS NOT NULL
),

asthma_encounters AS (
  -- I3: distinct visit_occurrences linked to an asthma diagnosis anywhere
  -- in the study window. "Asthma-related encounter" = visit at which an
  -- asthma condition_occurrence was recorded.
  SELECT
    person_id,
    COUNT(DISTINCT visit_occurrence_id) AS n_asthma_encounters
  FROM asthma_dx
  WHERE visit_occurrence_id IS NOT NULL
  GROUP BY person_id
),

confounded AS (
  -- E2: persons with any condition_occurrence mapping to the confounding
  -- chronic lung disease set, anywhere in their record.
  SELECT DISTINCT co.person_id
  FROM @cdmDatabaseSchema.condition_occurrence co
  INNER JOIN confounding_concepts cc
    ON co.condition_concept_id = cc.concept_id
),

eligible AS (
  SELECT
    a.person_id,
    a.index_date,
    a.age_at_index,
    a.gender_concept_id,
    ae.n_asthma_encounters
  FROM age_check a
  INNER JOIN asthma_encounters ae
    ON ae.person_id = a.person_id
  LEFT JOIN @cdmDatabaseSchema.death d
    ON d.person_id = a.person_id
  LEFT JOIN confounded x
    ON x.person_id = a.person_id
  WHERE a.age_at_index BETWEEN @minAge AND @maxAge
    AND ae.n_asthma_encounters >= @minAsthmaEncounters
    AND (d.death_date IS NULL OR d.death_date > a.index_date)
    AND x.person_id IS NULL
)

SELECT
  person_id,
  index_date,
  age_at_index,
  gender_concept_id,
  n_asthma_encounters
FROM eligible
ORDER BY person_id;
