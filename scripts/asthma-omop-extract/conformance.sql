/*********************************************************************************
* conformance.sql — pre-flight checks  (OHDSI SQL / SqlRender source)
*
* Run BEFORE extraction to see whether your site will produce data comparable to
* other sites. Each block returns a single value; etl.py --check evaluates them
* against thresholds and prints PASS/WARN/FAIL. A WARN doesn't block extraction —
* it flags a dimension where your corpus will differ (and why), which Paper-1
* analysis must account for (per the design's HIE-completeness caveat).
*********************************************************************************/

-- ==NAME asthma_concepts==  (must be > 0: vocabulary resolves SNOMED 317009)
SELECT COUNT(*) AS v FROM @cdm_database_schema.concept_ancestor WHERE ancestor_concept_id = 317009;

-- ==NAME visit_mapping_pct==  (% of visits mapped to standard 9201/9202/9203)
SELECT 100.0 * SUM(CASE WHEN visit_concept_id IN (9201,9202,9203) THEN 1 ELSE 0 END)
             / NULLIF(COUNT(*),0) AS v
FROM @cdm_database_schema.visit_occurrence;

-- ==NAME notes_populated==  (0 → no notes = the agents have no chart to read)
SELECT COUNT(*) AS v FROM @cdm_database_schema.note WHERE note_text IS NOT NULL;

-- ==NAME days_supply_pct==  (low → refill_pdc_12mo won't compute; SABA count still ok)
SELECT 100.0 * SUM(CASE WHEN days_supply IS NOT NULL THEN 1 ELSE 0 END)
             / NULLIF(COUNT(*),0) AS v
FROM @cdm_database_schema.drug_exposure;

-- ==NAME act_structured==  (0 → ACT lives in notes only, like INPC; T1-ACTScore comes from notes)
SELECT COUNT(*) AS v
FROM @cdm_database_schema.measurement m
INNER JOIN @cdm_database_schema.concept c ON c.concept_id = m.measurement_concept_id
WHERE c.concept_code = '75827-3';

-- ==NAME drug_ingredient_rollup==  (>0: drug_exposure rolls up to RxNorm ingredients)
SELECT COUNT(DISTINCT ca.ancestor_concept_id) AS v
FROM @cdm_database_schema.drug_exposure de
INNER JOIN @cdm_database_schema.concept_ancestor ca ON ca.descendant_concept_id = de.drug_concept_id
INNER JOIN @cdm_database_schema.concept ing
        ON ing.concept_id = ca.ancestor_concept_id
       AND ing.concept_class_id = 'Ingredient' AND ing.vocabulary_id = 'RxNorm';
