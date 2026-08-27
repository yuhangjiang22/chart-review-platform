/*********************************************************************************
* cohort.sql — Pediatric asthma adherence cohort  (OHDSI SQL / SqlRender source)
*                                                        instrument v0.5
*
* Render for YOUR dialect with OHDSI SqlRender, e.g. (R):
*   SqlRender::render(sql, cdm_database_schema='omop_cdm', min_age=2, max_age=17,
*                     min_asthma_encounters=2, study_start='2021-01-01',
*                     study_end='2099-12-31')  |>
*   SqlRender::translate(targetDialect='postgresql')   # or 'sql server','bigquery',
*                                                       # 'redshift','spark','duckdb'
*
* Portable: only standard OMOP tables + standard concept sets (SNOMED 317009 via
* concept_ancestor; standard visit_concept_ids). No dialect-specific syntax —
* date math uses SqlRender's DATEADD/YEAR (translated per dialect).
*
* ── DEFINITION (instrument v0.5) ───────────────────────────────────────────────
*   - Asthma: condition_concept_id IN descendants of SNOMED 317009 (ICD-10 J45.x
*     AND ICD-9 493.x map in via the standard concept — coding-scheme independent).
*   - An encounter is ASTHMA-RELATED when an asthma condition_occurrence is linked
*     to it by visit_occurrence_id.
*   - Countable encounter = asthma-related AND not inpatient. Primary care,
*     specialty, urgent care and ED all count; inpatient does not.
*   - index_date = most recent PEDIATRIC (age @min_age..@max_age) OUTPATIENT visit
*     (visit_concept_id = 9202). Outpatient-anchored so the lookback is populated.
*   - Eligible when the 12 months ending on index_date contain
*     >= @min_asthma_encounters countable encounters, AT LEAST ONE of them
*     non-ED (outpatient).
*
* ── WHAT CHANGED FROM THE v0.4 VERSION OF THIS FILE ───────────────────────────
* Two changes, both required for site cohorts to be comparable with each other.
* Parameter names and the output contract are otherwise unchanged, except that
* @min_lookback_visits is now @min_asthma_encounters (renamed because it no
* longer counts visits) and stratification columns are added to the SELECT.
*
*   1. The lookback counts ASTHMA-RELATED encounters, not any outpatient visit.
*      v0.4 counted every visit_concept_id=9202 in the window regardless of what
*      it was for, so a child with an asthma diagnosis somewhere in history plus
*      two unrelated visits (well-child, an ear infection) qualified with no
*      asthma care in the observation year at all.
*
*   2. ED encounters count toward the total (inpatient still does not), with at
*      least one non-ED encounter required. Clinical review (Fedele, 2026-08-15):
*      "A lot of kids with asthma will get most of their care through the ED. So,
*      I don't think I'd limit to no ED. I know we are focused on outpatient
*      adherence to guidelines so they'd need at least one outpatient encounter."
*
* ── KNOWN LIMITATION OF THE OUTPATIENT-ANCHORED INDEX ─────────────────────────
* index_date is the most recent pediatric outpatient visit of ANY kind, so a
* child whose latest visit was a well-child check gets an index anchored there,
* and asthma care earlier in the year can fall outside the 12-month window.
* Change 1 above excludes patients left with no asthma encounter at all, but the
* anchor still costs observation time for the patients who do qualify.
*
* Anchoring the index on the most recent ASTHMA encounter instead would remove
* that loss, at the cost of shifting index_date — and therefore the observation
* window — for most patients, which means re-extracting rather than reconciling.
* Deliberately NOT done here (study lead, 2026-08-27) so that sites which have
* already adapted this file need only the two changes above. Revisit if the
* per-encounter rules turn out to be denominator-starved at any site: sample
* across n_asthma_encounters_12mo (below) to see how much is being lost.
*
* ── STRATIFICATION COLUMNS ────────────────────────────────────────────────────
* The study plan samples ~30 patients/site stratified by asthma severity, age
* group and note volume. Sampling itself is left to the site (easier in R/Python
* than SQL), so this query emits the columns a stratified draw needs:
*
*   age_band_plan   — 2-5 / 6-11 / 12-17, the study plan's sampling bands.
*   age_band_naepp  — 2-4 / 5-11 / 12-17, the NAEPP guideline bands the
*                     instrument scores against. These are NOT the same bands;
*                     both are emitted so the sampling frame and the scoring
*                     frame can each use the right one.
*   n_asthma_encounters_12mo / n_ed_12mo / n_outpatient_12mo
*                   — encounter density. Draw across the range rather than
*                     uniformly at random: a patient with one asthma encounter in
*                     the year contributes one judgment per per-encounter rule,
*                     a patient with eight contributes eight. A simple random
*                     sample concentrates in the sparse tail.
*   n_notes_12mo    — note volume, from the standard NOTE table. Sites that do
*                     not populate NOTE get 0 here and should substitute their
*                     own document count.
*
* SEVERITY is deliberately NOT emitted. It is a clinical judgment, not a codeable
* field, and its structured proxies (controller class and dose, exacerbation
* count) are computed downstream in the extract step, which already has the drug
* rollup. Stratify on severity using the extract's output, not this query.
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
-- Encounters an asthma diagnosis is actually attached to. The link is
-- visit_occurrence_id, NOT a same-day match: a same-day rule flags every
-- encounter sharing a calendar day with an asthma diagnosis, which inflates the
-- asthma-encounter count on any day a patient was seen more than once.
asthma_visit AS (
  SELECT DISTINCT co.visit_occurrence_id AS vid
  FROM @cdm_database_schema.condition_occurrence co
  INNER JOIN asthma a ON co.condition_concept_id = a.cid
  WHERE co.visit_occurrence_id IS NOT NULL
),
op AS (  -- outpatient visits (9202) with age at visit — the index anchor
  SELECT v.person_id,
         v.visit_start_date AS vdate,
         YEAR(v.visit_start_date) - p.year_of_birth AS age
  FROM @cdm_database_schema.visit_occurrence v
  INNER JOIN @cdm_database_schema.person p ON p.person_id = v.person_id
  WHERE v.visit_concept_id = 9202 AND v.visit_start_date IS NOT NULL
),
-- Countable encounters for the lookback: asthma-related, not inpatient.
-- Inpatient is excluded by concept id rather than by enumerating the included
-- types, so a site whose urgent care maps to a local concept still counts:
--   9201 = Inpatient Visit, 262 = Emergency Room and Inpatient Visit,
--   9203 = Emergency Room Visit, 9202 = Outpatient Visit.
enc AS (
  SELECT v.person_id,
         v.visit_start_date AS vdate,
         CASE WHEN v.visit_concept_id = 9203 THEN 1 ELSE 0 END AS is_ed
  FROM @cdm_database_schema.visit_occurrence v
  INNER JOIN asthma_visit av ON av.vid = v.visit_occurrence_id
  WHERE v.visit_start_date IS NOT NULL
    AND v.visit_concept_id NOT IN (9201, 262)
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
-- Countable encounters in the 12 months ending on index_date, split by setting
-- so the "at least one non-ED" requirement is checkable.
lookback AS (
  SELECT ia.person_id,
         COUNT(*) AS n_asthma_encounters_12mo,
         SUM(enc.is_ed) AS n_ed_12mo,
         SUM(1 - enc.is_ed) AS n_outpatient_12mo
  FROM idx_age ia
  INNER JOIN enc ON enc.person_id = ia.person_id
  WHERE enc.vdate > DATEADD(MONTH, -12, ia.index_date)
    AND enc.vdate <= ia.index_date
  GROUP BY ia.person_id
),
-- Note volume for the note-volume stratum. LEFT JOINed below: a site that does
-- not populate NOTE must still return its cohort, with 0 here.
notes AS (
  SELECT ia.person_id, COUNT(*) AS n_notes_12mo
  FROM idx_age ia
  INNER JOIN @cdm_database_schema.note n ON n.person_id = ia.person_id
  WHERE n.note_date > DATEADD(MONTH, -12, ia.index_date)
    AND n.note_date <= ia.index_date
  GROUP BY ia.person_id
)
SELECT ia.person_id,
       ia.index_date,
       ia.age_at_index,
       CASE WHEN ia.age_at_index <= 5  THEN '2-5'
            WHEN ia.age_at_index <= 11 THEN '6-11'
            ELSE '12-17' END AS age_band_plan,
       CASE WHEN ia.age_at_index <= 4  THEN '2-4'
            WHEN ia.age_at_index <= 11 THEN '5-11'
            ELSE '12-17' END AS age_band_naepp,
       lb.n_asthma_encounters_12mo,
       lb.n_ed_12mo,
       lb.n_outpatient_12mo,
       COALESCE(nt.n_notes_12mo, 0) AS n_notes_12mo
FROM idx_age ia
INNER JOIN lookback lb ON lb.person_id = ia.person_id
LEFT JOIN notes nt ON nt.person_id = ia.person_id
WHERE ia.age_at_index BETWEEN @min_age AND @max_age
  AND lb.n_asthma_encounters_12mo >= @min_asthma_encounters
  -- At least one non-ED encounter: the study audits OUTPATIENT guideline
  -- adherence, so a patient seen only in the ED has no outpatient care to
  -- audit — while their ED visits still count toward having enough asthma
  -- contact to review (clinical review, change 2 above).
  AND lb.n_outpatient_12mo >= 1
  -- Study window on the index date. Default is post-2020 (>= 2021-01-01) so EVERY
  -- patient falls under ONE guideline edition — the 2020 NAEPP Focused Update —
  -- and no one is scored against SMART/LAMA before it existed. Widen (e.g.
  -- @study_start=1900-01-01) only if you add index-date-driven edition logic.
  AND ia.index_date >= '@study_start'
  AND ia.index_date <= '@study_end'
ORDER BY ia.person_id;
