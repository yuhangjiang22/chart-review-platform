/*********************************************************************************
* extracts.sql — Per-patient OMOP extracts  (OHDSI SQL / SqlRender source)
*
* Row-level SELECTs for the WHOLE cohort at once (join @cohort_table, filter each
* row to that patient's index_date). etl.py groups by person_id and applies the
* transform: drug→ingredient fills + saba_canisters_12mo, conditions dedup +
* icd10cm parse, asthma_related flag, and the v0.4 foundations (age_band,
* controller_active, lookback_outpatient_count_12mo, exacerbations_12mo).
*
* Keeping aggregation OUT of SQL (in Python) is what makes these portable: every
* block is a plain SELECT + standard joins, so SqlRender::translate() handles any
* dialect. Render with @cdm_database_schema, @cohort_table, @drug_class_table.
*
* @cohort_table       : table of (person_id, index_date) from cohort.sql
* @drug_class_table   : (ingredient_concept_id, drug_class, is_controller) map
*                       built by etl.py from RxNorm Ingredient names (portable)
*********************************************************************************/

-- ==NAME conditions==
SELECT co.person_id, co.condition_occurrence_id AS row_id, co.condition_concept_id AS concept_id,
       c.concept_name, co.condition_source_value, co.condition_start_date AS date
FROM @cdm_database_schema.condition_occurrence co
INNER JOIN @cohort_table ch ON ch.person_id = co.person_id
LEFT JOIN @cdm_database_schema.concept c ON c.concept_id = co.condition_concept_id
WHERE co.condition_start_date <= ch.index_date;

-- ==NAME drugs==  (rolled to RxNorm ingredient via concept_ancestor + class map)
SELECT de.person_id, de.drug_exposure_id AS row_id, dcm.ingredient_concept_id AS concept_id,
       ing.concept_name, ing.concept_code AS rxnorm, dcm.drug_class, dcm.is_controller,
       de.drug_exposure_start_date AS fill_date, de.days_supply, de.quantity
FROM @cdm_database_schema.drug_exposure de
INNER JOIN @cohort_table ch ON ch.person_id = de.person_id
INNER JOIN @cdm_database_schema.concept_ancestor ca ON ca.descendant_concept_id = de.drug_concept_id
INNER JOIN @drug_class_table dcm ON dcm.ingredient_concept_id = ca.ancestor_concept_id
LEFT JOIN @cdm_database_schema.concept ing ON ing.concept_id = dcm.ingredient_concept_id
WHERE de.drug_exposure_start_date <= ch.index_date;

-- ==NAME asthma_visits==  (asthma-dx visit ids + dates → Python flags asthma_related)
SELECT co.person_id, co.visit_occurrence_id AS vid, co.condition_start_date AS d
FROM @cdm_database_schema.condition_occurrence co
INNER JOIN @cohort_table ch ON ch.person_id = co.person_id
INNER JOIN @cdm_database_schema.concept_ancestor ca
        ON ca.descendant_concept_id = co.condition_concept_id AND ca.ancestor_concept_id = 317009
WHERE co.condition_start_date <= ch.index_date;

-- ==NAME encounters==
SELECT v.person_id, v.visit_occurrence_id AS row_id, v.visit_concept_id,
       v.visit_start_date AS start_date, v.visit_end_date AS end_date
FROM @cdm_database_schema.visit_occurrence v
INNER JOIN @cohort_table ch ON ch.person_id = v.person_id
WHERE v.visit_start_date <= ch.index_date;

-- ==NAME measurements==
SELECT m.person_id, m.measurement_id AS row_id, m.measurement_concept_id AS concept_id,
       c.concept_name, m.value_as_number, m.unit_source_value AS unit, m.measurement_date AS date
FROM @cdm_database_schema.measurement m
INNER JOIN @cohort_table ch ON ch.person_id = m.person_id
LEFT JOIN @cdm_database_schema.concept c ON c.concept_id = m.measurement_concept_id
WHERE m.measurement_date <= ch.index_date AND m.value_as_number IS NOT NULL;

-- ==NAME procedures==
SELECT po.person_id, po.procedure_occurrence_id AS row_id, po.procedure_concept_id AS concept_id,
       c.concept_name, po.procedure_source_value AS cpt, po.procedure_date AS date
FROM @cdm_database_schema.procedure_occurrence po
INNER JOIN @cohort_table ch ON ch.person_id = po.person_id
LEFT JOIN @cdm_database_schema.concept c ON c.concept_id = po.procedure_concept_id
WHERE po.procedure_date <= ch.index_date;

-- ==NAME notes==  (standard site: OMOP note table. RDRP adapter maps its parquet.)
SELECT n.person_id, n.note_date, n.doc_type, n.note_text
FROM @cdm_database_schema.note n
INNER JOIN @cohort_table ch ON ch.person_id = n.person_id
WHERE n.note_date <= ch.index_date AND n.note_text IS NOT NULL;
