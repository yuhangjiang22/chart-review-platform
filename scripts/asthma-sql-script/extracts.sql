-- ============================================================================
-- Asthma Adherence — Per-Patient OMOP Extracts
--
-- For each person_id in the cohort (output of cohort.sql), run the 6 queries
-- below; serialize each result set as a JSON array; drop the files under
--   corpus/patients/<anon_id>/omop/{conditions,drugs,measurements,
--                                    observations,procedures,encounters}.json
--
-- omop_etl.py runs these end-to-end. The queries are also broken out here so
-- the SQL can be reviewed, ported to another DBMS, or run ad hoc.
--
-- Parameters (bound at execution time):
--   {schema}              — OMOP CDM schema name (substituted as a literal)
--   :person_id            — one person_id from the cohort
--   :start_date           — index_date - lookback_days
--   :end_date             — index_date
--
-- For the drugs.json output, queries 2a + 2b + 2c run together — application
-- layer aggregates fills, computes refill_pdc_12mo (HEDIS MAM) and
-- saba_canisters_12mo using DRUG_CLASS_MAP from omop_etl.py.
--
-- SQL flavor: T-SQL (SQL Server). DATEDIFF/DATEADD/VARCHAR/TOP need porting
-- for Postgres/Snowflake.
-- ============================================================================


-- ==NAME conditions==
SELECT
  co.condition_occurrence_id    AS row_id,
  co.condition_concept_id       AS concept_id,
  c_std.concept_name            AS concept_name,
  c_src.concept_code            AS icd10cm,
  CASE WHEN co.condition_end_date IS NULL
         OR co.condition_end_date >= :end_date
       THEN 'active' ELSE 'resolved' END  AS status,
  co.condition_start_date       AS date
FROM {schema}.condition_occurrence co
LEFT JOIN {schema}.concept c_std
       ON c_std.concept_id = co.condition_concept_id
LEFT JOIN {schema}.concept c_src
       ON c_src.concept_id = co.condition_source_concept_id
      AND c_src.vocabulary_id = 'ICD10CM'
WHERE co.person_id = :person_id
  AND co.condition_start_date BETWEEN :start_date AND :end_date
ORDER BY co.condition_start_date, co.condition_occurrence_id;


-- ==NAME drug_regimens==
-- Aggregates drug_exposure rows by RxNorm INGREDIENT (one regimen per
-- ingredient). drug_class + is_controller filled in by omop_etl.py from
-- DRUG_CLASS_MAP.
WITH ingredient_per_exposure AS (
  SELECT
    de.drug_exposure_id,
    ca.ancestor_concept_id AS ingredient_concept_id,
    de.drug_exposure_start_date,
    de.drug_exposure_end_date
  FROM {schema}.drug_exposure de
  INNER JOIN {schema}.concept_ancestor ca
    ON ca.descendant_concept_id = de.drug_concept_id
  INNER JOIN {schema}.concept ing
    ON ing.concept_id = ca.ancestor_concept_id
   AND ing.concept_class_id = 'Ingredient'
   AND ing.vocabulary_id = 'RxNorm'
  WHERE de.person_id = :person_id
    AND de.drug_exposure_start_date BETWEEN :start_date AND :end_date
)
SELECT
  ingredient_concept_id                AS concept_id,
  ing.concept_name,
  ing.concept_code                     AS rxnorm,
  MIN(drug_exposure_id)                AS row_id,
  MIN(drug_exposure_start_date)        AS start_date,
  MAX(drug_exposure_end_date)          AS end_date,
  MAX(CASE WHEN drug_exposure_end_date IS NULL
            OR drug_exposure_end_date >= :end_date
           THEN 1 ELSE 0 END)          AS active
FROM ingredient_per_exposure ipe
INNER JOIN {schema}.concept ing
  ON ing.concept_id = ipe.ingredient_concept_id
GROUP BY ingredient_concept_id, ing.concept_name, ing.concept_code
ORDER BY MIN(drug_exposure_start_date);


-- ==NAME drug_fills==
-- One row per fill/dispense. omop_etl.py groups these by concept_id into
-- the fills[] sub-array of the regimen JSON, and uses them to compute
-- refill_pdc_12mo + saba_canisters_12mo.
SELECT
  ca.ancestor_concept_id          AS concept_id,
  de.drug_exposure_start_date     AS fill_date,
  de.days_supply,
  de.quantity
FROM {schema}.drug_exposure de
INNER JOIN {schema}.concept_ancestor ca
  ON ca.descendant_concept_id = de.drug_concept_id
INNER JOIN {schema}.concept ing
  ON ing.concept_id = ca.ancestor_concept_id
 AND ing.concept_class_id = 'Ingredient'
 AND ing.vocabulary_id = 'RxNorm'
WHERE de.person_id = :person_id
  AND de.drug_exposure_start_date BETWEEN :start_date AND :end_date
ORDER BY ca.ancestor_concept_id, de.drug_exposure_start_date;


-- ==NAME drug_sig==
-- Pulls the most recent non-null sig (instructions) for a given
-- (person, ingredient). Run once per regimen with :ingredient_id bound.
SELECT TOP 1 de.sig
FROM {schema}.drug_exposure de
INNER JOIN {schema}.concept_ancestor ca
  ON ca.descendant_concept_id = de.drug_concept_id
WHERE de.person_id = :person_id
  AND ca.ancestor_concept_id = :ingredient_id
  AND de.sig IS NOT NULL
ORDER BY de.drug_exposure_start_date DESC;


-- ==NAME measurements==
-- LOINC allowlist: ACT score, FEV1/FVC, FEV1, FVC, FeNO, BMI.
-- Sites may need to confirm these against their vocabulary release.
SELECT
  m.measurement_id              AS row_id,
  m.measurement_concept_id      AS concept_id,
  c_std.concept_name,
  c_src.concept_code            AS loinc,
  m.value_as_number             AS value,
  m.unit_source_value           AS unit,
  m.measurement_date            AS date,
  CAST(m.visit_occurrence_id AS VARCHAR(40))  AS encounter_id
FROM {schema}.measurement m
LEFT JOIN {schema}.concept c_std ON c_std.concept_id = m.measurement_concept_id
LEFT JOIN {schema}.concept c_src
       ON c_src.concept_id = m.measurement_source_concept_id
      AND c_src.vocabulary_id = 'LOINC'
WHERE m.person_id = :person_id
  AND m.measurement_date BETWEEN :start_date AND :end_date
  AND c_src.concept_code IN
      ('75827-3','19926-5','33452-4','20150-9','19868-9','76270-8','39156-5')
ORDER BY m.measurement_date, m.measurement_id;


-- ==NAME observations==
-- Allowlist: smoking status, asthma severity classification, action plan,
-- inhaler technique reviewed, exacerbation count.
-- Local site concept IDs may differ — verify before running on real data.
SELECT
  o.observation_id              AS row_id,
  o.observation_concept_id      AS concept_id,
  c.concept_name,
  COALESCE(o.value_as_string, c_val.concept_name,
           CAST(o.value_as_number AS VARCHAR(64)))  AS value_as_string,
  o.observation_date            AS date
FROM {schema}.observation o
LEFT JOIN {schema}.concept c     ON c.concept_id = o.observation_concept_id
LEFT JOIN {schema}.concept c_val ON c_val.concept_id = o.value_as_concept_id
WHERE o.person_id = :person_id
  AND o.observation_date BETWEEN :start_date AND :end_date
  AND o.observation_concept_id IN (4275495, 4221869, 4131909, 4053828, 37116217)
ORDER BY o.observation_date, o.observation_id;


-- ==NAME procedures==
-- CPT allowlist: spirometry (94060/94010/94375), influenza vaccine (90686/90688).
SELECT
  po.procedure_occurrence_id    AS row_id,
  po.procedure_concept_id       AS concept_id,
  c_std.concept_name,
  c_src.concept_code            AS cpt,
  po.procedure_date,
  prov.specialty_source_value   AS provider_specialty,
  CAST(po.visit_occurrence_id AS VARCHAR(40))  AS encounter_id
FROM {schema}.procedure_occurrence po
LEFT JOIN {schema}.concept c_std ON c_std.concept_id = po.procedure_concept_id
LEFT JOIN {schema}.concept c_src
       ON c_src.concept_id = po.procedure_source_concept_id
      AND c_src.vocabulary_id IN ('CPT4','HCPCS')
LEFT JOIN {schema}.provider prov ON prov.provider_id = po.provider_id
WHERE po.person_id = :person_id
  AND po.procedure_date BETWEEN :start_date AND :end_date
  AND c_src.concept_code IN ('94060','94010','94375','90686','90688')
ORDER BY po.procedure_date, po.procedure_occurrence_id;


-- ==NAME encounters==
SELECT
  v.visit_occurrence_id         AS row_id,
  CAST(v.visit_occurrence_id AS VARCHAR(40))  AS encounter_id,
  CASE v.visit_concept_id
    WHEN 9201 THEN 'Inpatient'
    WHEN 9202 THEN 'Outpatient'
    WHEN 9203 THEN 'Emergency'
    WHEN 581477 THEN 'Outpatient'
    WHEN 38004250 THEN 'Telehealth'
    WHEN 38004251 THEN 'Telehealth'
    ELSE c.concept_name END     AS type,
  cs.care_site_name             AS department,
  COALESCE(prov.provider_name,
           prov.last_name + ', ' + prov.first_name)  AS primary_provider,
  v.visit_start_date            AS start_date,
  v.visit_end_date              AS end_date
FROM {schema}.visit_occurrence v
LEFT JOIN {schema}.concept c   ON c.concept_id = v.visit_concept_id
LEFT JOIN {schema}.care_site cs ON cs.care_site_id = v.care_site_id
LEFT JOIN {schema}.provider prov ON prov.provider_id = v.provider_id
WHERE v.person_id = :person_id
  AND v.visit_start_date BETWEEN :start_date AND :end_date
ORDER BY v.visit_start_date, v.visit_occurrence_id;


-- ==NAME notes==
-- Clinical notes from the OMOP `note` table. One row per note; each row
-- becomes a .txt file at corpus/patients/<anon_id>/notes/<date>__<doc_type>.txt
-- via omop_etl.py.
--
-- Filtering:
--   - person_id + date window match
--   - non-empty note_text (skip stubs and auto-generated zero-length notes)
--   - note_type_concept_id allowlist: standard "clinical note" types
--     (progress notes, discharge summaries, consult notes, outpatient
--     notes). Adjust per site if WCM uses different local concepts.
--
-- The agent's `list_notes` + `read_notes` MCP tools read these from disk
-- after extraction — no DB access at runtime.
SELECT
  n.note_id,
  n.note_date,
  COALESCE(c_class.concept_name, c_type.concept_name) AS doc_type,
  n.note_title,
  n.note_text
FROM {schema}.note n
LEFT JOIN {schema}.concept c_type
       ON c_type.concept_id = n.note_type_concept_id
LEFT JOIN {schema}.concept c_class
       ON c_class.concept_id = n.note_class_concept_id
WHERE n.person_id = :person_id
  AND n.note_date BETWEEN :start_date AND :end_date
  AND n.note_text IS NOT NULL
  AND LEN(n.note_text) > 50
  AND (
    -- Standard clinical note types (LOINC-mapped via OMOP):
    --   44814637 progress note
    --   44814638 discharge summary
    --   44814648 consult note
    --   44814673 outpatient note
    --   706531   referral note
    n.note_type_concept_id IN (44814637, 44814638, 44814648, 44814673, 706531)
    -- Or anything classified as a clinical note via note_class_concept_id:
    OR LOWER(c_class.concept_name) LIKE '%progress%'
    OR LOWER(c_class.concept_name) LIKE '%discharge%'
    OR LOWER(c_class.concept_name) LIKE '%consult%'
    OR LOWER(c_class.concept_name) LIKE '%outpatient%'
    OR LOWER(c_class.concept_name) LIKE '%referral%'
    OR LOWER(c_class.concept_name) LIKE '%clinic note%'
  )
ORDER BY n.note_date, n.note_id;
