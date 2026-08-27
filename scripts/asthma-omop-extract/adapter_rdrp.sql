-- ============================================================================
-- adapter_rdrp.sql — SITE-SPECIFIC adapter: RDRP-6745 files -> standard OMOP
--
-- This is the ONLY site-specific file. It creates standard-OMOP-named VIEWS over
-- the RDRP-6745 delivery (CSV + parquet) so cohort.sql / extracts.sql can be
-- written against canonical OMOP names and stay portable. Another site swaps
-- this file for their own CDM (a schema search-path, or their own view layer)
-- and runs the same cohort/extracts unchanged.
--
-- RDRP-6745 quirks handled here:
--   * DEID_PERSON_ID (not person_id); UPPERCASE columns.
--   * Dates carry a time component -> substr(...,1,10)::DATE.
--   * CONDITION_SOURCE_VALUE is a composite ("1284^^J45.50^", ICD9 "2^^493.10^")
--     -> the ICD-10 display code is regex-extracted downstream; cohort matching
--        uses the STANDARD condition_concept_id (portable), never the composite.
--   * Notes are a partitioned PARQUET drop (REPORT_TYPE / PHYSIOLOGIC_TIME /
--     REPORT_TEXT), NOT an OMOP `note` table -> see the notes view below. A
--     standard site would instead map the OMOP `note` table.
--   * DAYS_SUPPLY is absent (all null) -> refill_pdc_12mo is not computed here.
--
-- Run against DuckDB:  duckdb -c ".read adapter_rdrp.sql" ...   (see run_duckdb.py)
-- {RD} is substituted with the RDRP-6745 directory path.
-- ============================================================================

CREATE OR REPLACE VIEW person AS
SELECT CAST(DEID_PERSON_ID AS VARCHAR) AS person_id,
       GENDER_CONCEPT_ID                AS gender_concept_id,
       CAST(YEAR_OF_BIRTH AS INTEGER)   AS year_of_birth
FROM read_csv_auto('{RD}/r6745_person.csv', ignore_errors=true);

-- Continuous-enrollment span. The cohort query requires >= 12 months of it
-- before index, so a patient whose records begin four months earlier is not
-- scored against a 12-month window they were only observable for a third of.
CREATE OR REPLACE VIEW observation_period AS
SELECT CAST(DEID_PERSON_ID AS VARCHAR)                     AS person_id,
       CAST(OBSERVATION_PERIOD_START_DATE AS DATE)         AS observation_period_start_date,
       CAST(OBSERVATION_PERIOD_END_DATE AS DATE)           AS observation_period_end_date
FROM read_csv_auto('{RD}/r6745_observation_period.csv', ignore_errors=true);

CREATE OR REPLACE VIEW condition_occurrence AS
SELECT CAST(DEID_PERSON_ID AS VARCHAR)                                   AS person_id,
       CAST(CONDITION_OCCURRENCE_ID AS VARCHAR)                          AS condition_occurrence_id,
       CONDITION_CONCEPT_ID                                              AS condition_concept_id,
       TRY_CAST(substr(CAST(CONDITION_START_DATE AS VARCHAR),1,10) AS DATE) AS condition_start_date,
       TRY_CAST(substr(CAST(CONDITION_END_DATE   AS VARCHAR),1,10) AS DATE) AS condition_end_date,
       CAST(VISIT_OCCURRENCE_ID AS VARCHAR)                              AS visit_occurrence_id,
       CONDITION_SOURCE_VALUE                                            AS condition_source_value
FROM read_csv_auto('{RD}/r6745_condition_occurrence.csv', ignore_errors=true);

CREATE OR REPLACE VIEW drug_exposure AS
SELECT CAST(DEID_PERSON_ID AS VARCHAR)                                    AS person_id,
       CAST(DRUG_EXPOSURE_ID AS VARCHAR)                                  AS drug_exposure_id,
       DRUG_CONCEPT_ID                                                    AS drug_concept_id,
       TRY_CAST(substr(CAST(DRUG_EXPOSURE_START_DATE AS VARCHAR),1,10) AS DATE) AS drug_exposure_start_date,
       TRY_CAST(DAYS_SUPPLY AS INTEGER)                                   AS days_supply,
       TRY_CAST(QUANTITY AS DOUBLE)                                       AS quantity
FROM read_csv_auto('{RD}/r6745_drug_exposure.csv', ignore_errors=true);

CREATE OR REPLACE VIEW visit_occurrence AS
SELECT CAST(DEID_PERSON_ID AS VARCHAR)                                    AS person_id,
       CAST(VISIT_OCCURRENCE_ID AS VARCHAR)                               AS visit_occurrence_id,
       VISIT_CONCEPT_ID                                                   AS visit_concept_id,
       TRY_CAST(substr(CAST(VISIT_START_DATE AS VARCHAR),1,10) AS DATE)   AS visit_start_date,
       TRY_CAST(substr(CAST(VISIT_END_DATE   AS VARCHAR),1,10) AS DATE)   AS visit_end_date
FROM read_csv_auto('{RD}/r6745_visit_occurrence.csv', ignore_errors=true);

CREATE OR REPLACE VIEW procedure_occurrence AS
SELECT CAST(DEID_PERSON_ID AS VARCHAR)                                    AS person_id,
       CAST(PROCEDURE_OCCURRENCE_ID AS VARCHAR)                           AS procedure_occurrence_id,
       PROCEDURE_CONCEPT_ID                                               AS procedure_concept_id,
       TRY_CAST(substr(CAST(PROCEDURE_DATE AS VARCHAR),1,10) AS DATE)     AS procedure_date,
       PROCEDURE_SOURCE_VALUE                                             AS procedure_source_value
FROM read_csv_auto('{RD}/r6745_procedure_occurrence.csv', ignore_errors=true);

CREATE OR REPLACE VIEW measurement AS
SELECT CAST(DEID_PERSON_ID AS VARCHAR)                                    AS person_id,
       CAST(MEASUREMENT_ID AS VARCHAR)                                    AS measurement_id,
       MEASUREMENT_CONCEPT_ID                                             AS measurement_concept_id,
       TRY_CAST(substr(CAST(MEASUREMENT_DATE AS VARCHAR),1,10) AS DATE)   AS measurement_date,
       TRY_CAST(VALUE_AS_NUMBER AS DOUBLE)                                AS value_as_number,
       UNIT_SOURCE_VALUE                                                  AS unit_source_value
FROM read_csv_auto('{RD}/r6745_measurement.csv', ignore_errors=true);

CREATE OR REPLACE VIEW observation AS
SELECT CAST(DEID_PERSON_ID AS VARCHAR)                                    AS person_id,
       CAST(OBSERVATION_ID AS VARCHAR)                                    AS observation_id,
       OBSERVATION_CONCEPT_ID                                             AS observation_concept_id,
       TRY_CAST(substr(CAST(OBSERVATION_DATE AS VARCHAR),1,10) AS DATE)   AS observation_date,
       VALUE_AS_STRING                                                    AS value_as_string,
       TRY_CAST(VALUE_AS_NUMBER AS DOUBLE)                                AS value_as_number
FROM read_csv_auto('{RD}/r6745_observation.csv', ignore_errors=true);

CREATE OR REPLACE VIEW concept AS
SELECT CONCEPT_ID concept_id, CONCEPT_NAME concept_name, DOMAIN_ID domain_id,
       VOCABULARY_ID vocabulary_id, CONCEPT_CLASS_ID concept_class_id,
       STANDARD_CONCEPT standard_concept, CONCEPT_CODE concept_code
FROM read_csv_auto('{RD}/r6745_concept.csv', ignore_errors=true);

CREATE OR REPLACE VIEW concept_ancestor AS
SELECT ancestor_concept_id, descendant_concept_id
FROM read_csv_auto('{RD}/r6745_concept_ancestor.csv', ignore_errors=true);

-- Notes: RDRP ships them as year-partitioned parquet, NOT an OMOP `note` table.
-- Column names map to the note-table shape a standard site would use.
CREATE OR REPLACE VIEW note AS
SELECT CAST(DEID_PERSON_ID AS VARCHAR)                                    AS person_id,
       TRY_CAST(substr(CAST(PHYSIOLOGIC_TIME AS VARCHAR),1,10) AS DATE)   AS note_date,
       REPORT_TYPE                                                        AS doc_type,
       REPORT_TEXT                                                        AS note_text
FROM read_parquet('{RD_NOTES}/*/*.parquet');
