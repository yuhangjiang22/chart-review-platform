/*********************************************************************************
* cohort.sql — Pediatric asthma adherence cohort  (OHDSI SQL / SqlRender source)
*                                                        instrument v0.5
*
* Render for YOUR dialect with OHDSI SqlRender, e.g. (R):
*   SqlRender::render(sql, cdm_database_schema='omop_cdm', min_age=2, max_age=17,
*                     min_asthma_encounters=2, min_prior_observation_days=365,
*                     min_notes_12mo=0,
*                     study_start='2021-01-01', study_end='2099-12-31')  |>
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
*   - AND the patient is continuously observable for
*     >= @min_prior_observation_days before index_date (OMOP observation_period).
*   - AND has >= @min_notes_12mo notes in the lookback window. DEFAULT 0, i.e.
*     OFF — see WHY THE NOTE FLOOR IS OPT-IN below.
*
* ── WHY THE PRIOR-OBSERVATION REQUIREMENT ─────────────────────────────────────
* Without it, a child whose records begin four months before index is scored
* against a 12-month window they were only observable for a third of. Every
* absence-based answer then reads as a care gap: no spirometry found, no action
* plan documented, exacerbation count of zero. Adherence would come out lower
* for patients with shorter data, and the attribution would skew to
* DOCUMENTATION_GAP for a reason that has nothing to do with care. The standard
* OHDSI guard is a minimum prior-observation window, and it costs little here:
* measured at one development site, 98% of otherwise-eligible patients already
* have >= 365 days.
*
* The instrument's LONGEST lookback is the 24-month spirometry question, so a
* patient with 365-729 days of prior observation is fully observable for every
* question EXCEPT that one. Requiring 730 days for everyone would shrink the
* cohort for the sake of a single question, so instead
* `days_observed_before_index` is emitted (below) — exclude the short-lookback
* patients from the spirometry rule at analysis time rather than from the
* cohort.
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
*   days_observed_before_index
*                   — how much of the window the patient was actually
*                     observable for. Use it to scope the 24-month spirometry
*                     rule (see above) and to check that a stratum is not
*                     confounded by data availability.
*   n_notes_12mo    — note volume, from the standard NOTE table. Sites that do
*                     not populate NOTE get 0 here and should substitute their
*                     own document count.
*
* ── WHY THE NOTE FLOOR IS OPT-IN ──────────────────────────────────────────────
* Event-level annotation is read FROM NOTES: what the control picture was at that
* visit, whether the regimen matched, whether a follow-up was arranged. A patient
* can satisfy every criterion above and still be unannotatable — a real WCM draw
* returned one with 2 qualifying asthma encounters and n_notes_12mo = 1 (37 notes
* on the chart, one inside the window). Two events, one note: the annotator has
* almost nothing to read and most answers land on "cannot determine", which then
* has to be told apart from a genuine care gap.
*
* But @min_notes_12mo DEFAULTS TO 0 (no filter), because not every OMOP site
* populates the standard NOTE table. A hard floor would silently return zero
* patients at such a site with nothing to indicate why — a new hidden premise, of
* exactly the kind that has already cost this project real runs. Set it
* explicitly once you have seen the distribution of n_notes_12mo in an unfiltered
* draw, so you know what a given floor costs before you pay it. Sites that store
* documents elsewhere should filter on their own count instead.
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
-- Continuous-enrollment span before index. A site whose observation_period is
-- unreliable (some HIEs) can substitute the patient's earliest record date, but
-- must say so — the two are not equivalent: earliest-record is a lower bound on
-- observability, observation_period is an assertion of it.
obs AS (
  SELECT ia.person_id,
         MIN(op2.observation_period_start_date) AS observation_start_date
  FROM idx_age ia
  INNER JOIN @cdm_database_schema.observation_period op2 ON op2.person_id = ia.person_id
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
       COALESCE(nt.n_notes_12mo, 0) AS n_notes_12mo,
       DATEDIFF(DAY, ob.observation_start_date, ia.index_date) AS days_observed_before_index
FROM idx_age ia
INNER JOIN lookback lb ON lb.person_id = ia.person_id
INNER JOIN obs ob ON ob.person_id = ia.person_id
LEFT JOIN notes nt ON nt.person_id = ia.person_id
WHERE ia.age_at_index BETWEEN @min_age AND @max_age
  AND lb.n_asthma_encounters_12mo >= @min_asthma_encounters
  -- At least one non-ED encounter: the study audits OUTPATIENT guideline
  -- adherence, so a patient seen only in the ED has no outpatient care to
  -- audit — while their ED visits still count toward having enough asthma
  -- contact to review (clinical review, change 2 above).
  AND lb.n_outpatient_12mo >= 1
  -- Continuous observability before index (see the header). Set
  -- @min_prior_observation_days to 365 to match the 12-month observation
  -- period; raising it to 730 also covers the spirometry question's lookback,
  -- at the cost of dropping patients.
  AND ob.observation_start_date <= DATEADD(DAY, -@min_prior_observation_days, ia.index_date)
  -- Note floor. DEFAULT 0 = no filter; see WHY THE NOTE FLOOR IS OPT-IN. The
  -- COALESCE matters: `notes` is a LEFT JOIN, so a patient with no notes at all
  -- has NULL here, and `NULL >= 0` is UNKNOWN — which would drop exactly the
  -- patients the default is supposed to keep.
  AND COALESCE(nt.n_notes_12mo, 0) >= @min_notes_12mo
  -- Study window on the index date. Default is post-2020 (>= 2021-01-01) so EVERY
  -- patient falls under ONE guideline edition — the 2020 NAEPP Focused Update —
  -- and no one is scored against SMART/LAMA before it existed. Widen (e.g.
  -- @study_start=1900-01-01) only if you add index-date-driven edition logic.
  AND ia.index_date >= '@study_start'
  AND ia.index_date <= '@study_end'
ORDER BY ia.person_id;
