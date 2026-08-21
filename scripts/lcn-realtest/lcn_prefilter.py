#!/usr/bin/env python3
"""LCN candidate prefilter (dual-channel) over r6263.

Selects LIKELY-COMPENSATED cirrhosis candidates for agent review:
  1. cirrhosis code present; index = first cirrhosis code + 90d
  2. adult: age >= 18 at index
  3. Step-1 evidence density >= 2 signals (low platelets <150 in 6mo;
     elastography/stiffness in 1y; imaging notes with nodular+splenomegaly in
     1y; varices signal in 3y — notes keyword or EGD+varices code)
  4. ENTRY EXCLUSION (Compensated_CP_v2): no HCC/cholangiocarcinoma code on
     or before index.
  5. DUAL-CHANNEL decompensation screen over the 365d window before index —
     candidate must be clean on BOTH:
       codes channel: no ascites/HE/variceal-bleed condition codes
       notes channel: no decompensation keywords in any note text
     (Keyword hits include negations ("no ascites") — deliberately
      conservative: prefilter may discard some true compensated patients,
      but what passes is much more likely truly compensated. The agent
      still verifies everything.)

Usage: python3 lcn_prefilter.py [--top 10]
"""
import argparse
import duckdb

D = "/Users/yj38/Documents/liver-cp/data"
DECOMP_CODE_PAT = "(ascites|hepatic encephalopathy|[oe]sophageal varice.*(bleed|h(a)?emorrhage)|hepatorenal)"
DECOMP_KW = "(ascites|paracentesis|hepatic encephalopathy|lactulose|rifaximin|variceal (bleed|hemorrhage)|hematemesis|asterixis)"
LIVER_CA_PAT = "(hepatocellular carcinoma|liver cell carcinoma|cholangiocarcinoma|malignant neoplasm of (the )?liver|malignant tumo(u)?r of liver)"

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--top", type=int, default=10)
    a = ap.parse_args()
    con = duckdb.connect()
    con.execute("PRAGMA threads=4; PRAGMA memory_limit='6GB'; PRAGMA temp_directory='/private/tmp/duck_tmp'")
    con.execute(f"CREATE VIEW cn AS SELECT concept_id, concept_name FROM read_csv_auto('{D}/r6263_concept.csv')")
    con.execute(f"CREATE VIEW co AS SELECT person_id, condition_concept_id cid, CAST(condition_start_date AS DATE) d FROM read_csv_auto('{D}/r6263_condition_occurrence.csv')")
    con.execute(f"CREATE VIEW m AS SELECT person_id, measurement_concept_id mid, CAST(measurement_date AS DATE) d, value_as_number v FROM read_csv_auto('{D}/r6263_measurement.csv')")
    con.execute(f"CREATE VIEW nt AS SELECT person_id, CAST(PHYSIOLOGIC_TIME AS DATE) d, SERVICE_NAME s, REPORT_TEXT t FROM read_parquet('{D}/notes/rdrp_6263-report-export-*.parquet')")

    con.execute(f"""CREATE TABLE cand AS
WITH cir AS (
  SELECT co.person_id, MIN(co.d) first_cir
  FROM co JOIN cn ON cn.concept_id=co.cid
  WHERE lower(cn.concept_name) LIKE '%cirrhosis%' GROUP BY 1),
idx AS (
  SELECT c.person_id, c.first_cir, CAST(c.first_cir + INTERVAL 90 DAY AS DATE) ix,
         (SELECT date_part('year', CAST(c.first_cir + INTERVAL 90 DAY AS DATE)) - p.year_of_birth
          FROM read_csv_auto('{D}/r6263_person.csv') p WHERE p.person_id=c.person_id) age
  FROM cir c)
SELECT i.*,
 (SELECT COUNT(*) FROM nt WHERE nt.person_id=i.person_id AND nt.d<=i.ix AND nt.d>=i.ix-INTERVAL 5 YEAR) n_notes,
 -- Step-1 evidence signals
 (SELECT COUNT(*)>0 FROM m JOIN cn ON cn.concept_id=m.mid WHERE m.person_id=i.person_id
   AND lower(cn.concept_name) LIKE '%platelet%' AND m.v<150 AND m.d<=i.ix AND m.d>=i.ix-INTERVAL 6 MONTH) sig_plt,
 (SELECT COUNT(*)>0 FROM m JOIN cn ON cn.concept_id=m.mid WHERE m.person_id=i.person_id
   AND (lower(cn.concept_name) LIKE '%elastograph%' OR lower(cn.concept_name) LIKE '%stiffness%')
   AND m.d<=i.ix AND m.d>=i.ix-INTERVAL 1 YEAR) sig_stiff,
 (SELECT COUNT(*)>0 FROM nt WHERE nt.person_id=i.person_id AND nt.d<=i.ix AND nt.d>=i.ix-INTERVAL 1 YEAR
   AND regexp_matches(lower(nt.t),'nodular') AND regexp_matches(lower(nt.t),'splenomegaly')) sig_img,
 (SELECT COUNT(*)>0 FROM nt WHERE nt.person_id=i.person_id AND nt.d<=i.ix AND nt.d>=i.ix-INTERVAL 3 YEAR
   AND regexp_matches(lower(nt.t),'varices')) sig_varices,
 -- decompensation channel 1: codes in 365d window
 (SELECT COUNT(*) FROM co c2 JOIN cn ON cn.concept_id=c2.cid WHERE c2.person_id=i.person_id
   AND c2.d<=i.ix AND c2.d>=i.ix-INTERVAL 365 DAY
   AND regexp_matches(lower(cn.concept_name),'{DECOMP_CODE_PAT}')) decomp_codes,
 -- decompensation channel 2: note keywords in 365d window
 (SELECT COUNT(*) FROM nt WHERE nt.person_id=i.person_id AND nt.d<=i.ix AND nt.d>=i.ix-INTERVAL 365 DAY
   AND regexp_matches(lower(nt.t),'{DECOMP_KW}')) decomp_kw,
 -- entry exclusion (Compensated_CP_v2): HCC / cholangiocarcinoma dx on or before index
 (SELECT COUNT(*) FROM co c3 JOIN cn ON cn.concept_id=c3.cid WHERE c3.person_id=i.person_id
   AND c3.d<=i.ix AND regexp_matches(lower(cn.concept_name),'{LIVER_CA_PAT}')) liver_ca_codes
FROM idx i""")

    rows = con.execute(f"""
      SELECT person_id, first_cir, ix, CAST(age AS INT),
             n_notes,
             CAST(sig_plt AS INT)+CAST(sig_stiff AS INT)+CAST(sig_img AS INT)+CAST(sig_varices AS INT) AS sig_score,
             sig_plt, sig_stiff, sig_img, sig_varices
      FROM cand
      WHERE age >= 18
        AND n_notes BETWEEN 8 AND 60
        AND decomp_codes = 0 AND decomp_kw = 0
        AND liver_ca_codes = 0
        AND CAST(sig_plt AS INT)+CAST(sig_stiff AS INT)+CAST(sig_img AS INT)+CAST(sig_varices AS INT) >= 2
      ORDER BY sig_score DESC, n_notes ASC
      LIMIT {a.top}""").fetchall()
    total = con.execute("""SELECT COUNT(*) FROM cand WHERE age>=18 AND decomp_codes=0 AND decomp_kw=0 AND liver_ca_codes=0
        AND CAST(sig_plt AS INT)+CAST(sig_stiff AS INT)+CAST(sig_img AS INT)+CAST(sig_varices AS INT)>=2""").fetchone()[0]
    print(f"dual-channel-clean adults with >=2 Step-1 signals: {total}")
    print(f"{'person_id':<20}{'first_cir':<12}{'index':<12}{'age':<5}{'notes':<7}{'score':<6}plt/stiff/img/varices")
    for r in rows:
        print(f"{str(r[0]):<20}{str(r[1]):<12}{str(r[2]):<12}{r[3]:<5}{r[4]:<7}{r[5]:<6}{int(r[6])}/{int(r[7])}/{int(r[8])}/{int(r[9])}")

if __name__ == "__main__":
    main()
