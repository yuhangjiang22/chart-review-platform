#!/usr/bin/env python3
"""LCN clean-cohort prep (rule-based, per Dai Hao's plan + Compensated_CP_v2).

Input : docs/aud_cohort_with_demographics.csv  (156k AUD cohort; index = first AUD)
        data/r6263_*.csv + data/notes/*.parquet (LOCAL SLICE — 5k persons)
Output: docs/lcn_clean_cohort_local.csv — cohort ∩ local data, with entry-exclusion
        flags and the clean subset marked.

Entry exclusions:
  1. liver cancer (HCC / cholangiocarcinoma) diagnosed ON OR BEFORE index
     (Compensated_CP_v2: "Excluded at entry") — ICD-10 C22*/C24.0, ICD-9 155*,
     or concept-name match.
  2. documented cardiac cirrhosis — K76.1 or concept-name match, ANY time
     ("documented" is not windowed in the spec). NOTE: K76.1 = chronic passive
     congestion of liver — broader than strict cardiac cirrhosis; deliberate,
     conservative.
  3. known FALD — Fontan mention in conditions/procedures (concept or source)
     OR in note text, ANY time. FALD has no dedicated ICD-10 code.
  Note regex excludes 'fontanelle'/'fontanel' and 'Fontana(-Masson)' — the
  first run flagged 9 patients, ALL false positives from those two words.
  4. congenital biliary atresia — Q44.2 / ICD-9 751.61 or concept-name match,
     ANY time (congenital). Added after the pilot audit: one pilot MET was a
     biliary-atresia / secondary-biliary-cirrhosis patient with an AUD code at
     age 13 — etiology contamination, not alcohol-related liver disease.

  5. age < 18 ON THE INDEX DATE (age_at_index from the cohort CSV) — the
     Tapper definition targets adults; decided 2026-08-25: minors at index are
     excluded at entry (the outcome scanner's own 18th-birthday clamp remains
     as belt-and-suspenders for any legacy materializations).

Prints counts only (no ids). The output CSV stays local (data dir is PHI-adjacent).
"""
import duckdb, os

LP = "/Users/yj38/Documents/liver-cp"
CSV = f"{LP}/docs/aud_cohort_with_demographics.csv"
OUT = f"{LP}/docs/lcn_clean_cohort_local.csv"

LIVER_CA_NAME = r"(hepatocellular carcinoma|liver cell carcinoma|cholangiocarcinoma|malignant neoplasm of (the )?liver|malignant tumo(u)?r of liver)"
CARDIAC_NAME  = r"(cardiac cirrhosis|chronic passive congestion of liver|congestive hepatopath)"

con = duckdb.connect()
con.execute("PRAGMA threads=4; PRAGMA memory_limit='6GB'; PRAGMA temp_directory='/private/tmp/duck_tmp'")
con.execute(f"CREATE VIEW cohort_all AS SELECT CAST(person_id AS VARCHAR) pid, CAST(index_date AS DATE) ix, age_at_index, sex, race_ethnicity FROM read_csv_auto('{CSV}')")
con.execute(f"CREATE VIEW per AS SELECT CAST(person_id AS VARCHAR) pid FROM read_csv_auto('{LP}/data/r6263_person.csv')")
con.execute(f"CREATE VIEW cn  AS SELECT concept_id, concept_name FROM read_csv_auto('{LP}/data/r6263_concept.csv')")
con.execute(f"""CREATE VIEW co AS SELECT CAST(person_id AS VARCHAR) pid, condition_concept_id cid,
  CAST(condition_start_date AS DATE) d, COALESCE(condition_source_value,'') sv
  FROM read_csv_auto('{LP}/data/r6263_condition_occurrence.csv')""")
con.execute(f"""CREATE VIEW po AS SELECT CAST(person_id AS VARCHAR) pid, procedure_concept_id cid,
  COALESCE(procedure_source_value,'') sv
  FROM read_csv_auto('{LP}/data/r6263_procedure_occurrence.csv')""")
con.execute(f"""CREATE VIEW nt AS SELECT CAST(person_id AS VARCHAR) pid, REPORT_TEXT t
  FROM read_parquet('{LP}/data/notes/rdrp_6263-report-export-*.parquet')""")

con.execute("CREATE TABLE base AS SELECT c.* FROM cohort_all c JOIN per USING (pid)")
n_local = con.execute("SELECT count(*) FROM base").fetchone()[0]

con.execute(f"""CREATE TABLE flags AS
SELECT b.*,
 EXISTS (SELECT 1 FROM co JOIN cn ON cn.concept_id = co.cid
   WHERE co.pid = b.pid AND co.d <= b.ix
     AND (regexp_matches(lower(cn.concept_name), '{LIVER_CA_NAME}')
          OR co.sv LIKE 'C22%' OR co.sv LIKE 'C24.0%' OR co.sv LIKE '155%')) AS excl_liver_cancer,
 EXISTS (SELECT 1 FROM co JOIN cn ON cn.concept_id = co.cid
   WHERE co.pid = b.pid
     AND (regexp_matches(lower(cn.concept_name), '{CARDIAC_NAME}')
          OR co.sv LIKE 'K76.1%')) AS excl_cardiac_cirrhosis,
 (EXISTS (SELECT 1 FROM co JOIN cn ON cn.concept_id = co.cid
    WHERE co.pid = b.pid AND (lower(cn.concept_name) LIKE '%fontan%' OR lower(co.sv) LIKE '%fontan%'))
  OR EXISTS (SELECT 1 FROM po JOIN cn ON cn.concept_id = po.cid
    WHERE po.pid = b.pid AND (lower(cn.concept_name) LIKE '%fontan%' OR lower(po.sv) LIKE '%fontan%'))
  OR EXISTS (SELECT 1 FROM nt
    WHERE nt.pid = b.pid AND regexp_matches(lower(nt.t), 'fontan($|[^ae])'))) AS excl_fald,
 EXISTS (SELECT 1 FROM co JOIN cn ON cn.concept_id = co.cid
   WHERE co.pid = b.pid
     AND (lower(cn.concept_name) LIKE '%biliary atresia%'
          OR co.sv LIKE 'Q44.2%' OR co.sv LIKE '751.61%')) AS excl_biliary_atresia,
 (b.age_at_index IS NOT NULL AND b.age_at_index < 18) AS excl_age_lt18
FROM base b""")

stats = con.execute("""SELECT
  count(*) total,
  sum(CAST(excl_liver_cancer AS INT)) ca,
  sum(CAST(excl_cardiac_cirrhosis AS INT)) cc,
  sum(CAST(excl_fald AS INT)) fa,
  sum(CAST(excl_biliary_atresia AS INT)) ba,
  sum(CAST(excl_age_lt18 AS INT)) u18,
  sum(CAST(NOT excl_liver_cancer AND NOT excl_cardiac_cirrhosis AND NOT excl_fald
           AND NOT excl_biliary_atresia AND NOT excl_age_lt18 AS INT)) clean
FROM flags""").fetchone()

con.execute(f"""COPY (
  SELECT pid AS person_id, ix AS index_date, age_at_index, sex, race_ethnicity,
         excl_liver_cancer, excl_cardiac_cirrhosis, excl_fald, excl_biliary_atresia,
         excl_age_lt18,
         (NOT excl_liver_cancer AND NOT excl_cardiac_cirrhosis AND NOT excl_fald
          AND NOT excl_biliary_atresia AND NOT excl_age_lt18) AS clean
  FROM flags ORDER BY person_id
) TO '{OUT}' (HEADER)""")

print(f"[prep] AUD cohort ∩ local r6263 slice : {n_local}")
print(f"[prep] excluded — liver cancer ≤index : {stats[1]}")
print(f"[prep] excluded — cardiac cirrhosis   : {stats[2]}")
print(f"[prep] excluded — FALD (codes+notes)  : {stats[3]}")
print(f"[prep] excluded — biliary atresia     : {stats[4]}")
print(f"[prep] excluded — age<18 at index      : {stats[5]}")
print(f"[prep] CLEAN cohort                   : {stats[6]}")
print(f"[prep] -> {OUT}")
