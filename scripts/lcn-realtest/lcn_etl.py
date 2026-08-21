#!/usr/bin/env python3
"""LCN r6263 OMOP -> platform-corpus ETL.

Materializes real patients as corpus/patients/patient_real_lcn_<hash>/
{meta.json, omop/*.json, notes/*.txt} for the chart-review-lcn-cirrhosis task.

Index date (candidate outcome date) = first cirrhosis condition date + 90 days
(pragmatic pilot choice: the diagnostic workup falls inside the criterion
lookback windows; the study's index/longitudinal-scan design is still TBD in
lcn-definitions.docx).

Chart is filtered to date <= index_date. Real patients -> meta.phi=true
(routes the agent to the HIPAA model). Usage:
  python3 lcn_etl.py --patients 116800...,116800... [--out <corpus/patients>]
"""
import argparse, hashlib, json, os, re
import duckdb

D = "/Users/yj38/Documents/liver-cp/data"
DEFAULT_OUT = "/Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform/corpus/patients"
NOTE_CAP = 40
PRIORITY = ("radiol", "imaging", "ct ", "mri", "ultrasound", "endoscop", "gi ",
            "patholog", "hepatol", "gastro", "discharge", "operative")

def slug(s):
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", (s or "note").lower())).strip("_")[:40]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--patients", required=True)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--salt", default=os.environ.get("ETL_SALT", "rdrp6263"))
    a = ap.parse_args()
    pids = [p.strip() for p in a.patients.split(",") if p.strip()]
    con = duckdb.connect()
    con.execute("PRAGMA threads=4; PRAGMA memory_limit='6GB'; PRAGMA temp_directory='/private/tmp/duck_tmp'")
    con.execute(f"CREATE VIEW cn AS SELECT concept_id, concept_name FROM read_csv_auto('{D}/r6263_concept.csv')")
    inlist = ",".join(pids)

    # index per patient: first cirrhosis condition + 90d
    idx = {str(r[0]): (str(r[1]), str(r[2])) for r in con.execute(f"""
      SELECT co.person_id, MIN(CAST(condition_start_date AS DATE)) fc,
             CAST(MIN(CAST(condition_start_date AS DATE)) + INTERVAL 90 DAY AS DATE) ix
      FROM read_csv_auto('{D}/r6263_condition_occurrence.csv') co
      JOIN cn ON cn.concept_id = co.condition_concept_id
      WHERE lower(cn.concept_name) LIKE '%cirrhosis%' AND co.person_id IN ({inlist})
      GROUP BY 1""").fetchall()}

    person = {str(r[0]): r[1:] for r in con.execute(f"""
      SELECT p.person_id, p.year_of_birth, g.concept_name
      FROM read_csv_auto('{D}/r6263_person.csv') p
      LEFT JOIN cn g ON g.concept_id = p.gender_concept_id
      WHERE p.person_id IN ({inlist})""").fetchall()}

    for pid in pids:
        if pid not in idx:
            print(f"[skip] {pid}: no cirrhosis code"); continue
        first_cir, index_date = idx[pid]
        yob, sex = person.get(pid, (None, None))
        age = int(index_date[:4]) - int(yob) if yob else None
        anon = "patient_real_lcn_" + hashlib.sha256((a.salt + pid).encode()).hexdigest()[:12]
        pdir = os.path.join(a.out, anon)
        os.makedirs(pdir + "/omop", exist_ok=True); os.makedirs(pdir + "/notes", exist_ok=True)

        conds = [dict(row_id=r[0], concept_name=r[1], icd10cm=r[2], date=str(r[3]), status="active")
          for r in con.execute(f"""SELECT condition_occurrence_id, cn.concept_name, condition_source_value,
              CAST(condition_start_date AS DATE)
            FROM read_csv_auto('{D}/r6263_condition_occurrence.csv') co JOIN cn ON cn.concept_id=co.condition_concept_id
            WHERE co.person_id={pid} AND CAST(condition_start_date AS DATE) <= DATE '{index_date}'
            ORDER BY 4""").fetchall()]

        meas = [dict(row_id=r[0], concept_name=r[1], value=r[2], unit=r[3], date=str(r[4]))
          for r in con.execute(f"""SELECT measurement_id, cn.concept_name, value_as_number,
              COALESCE(u.concept_name, m.unit_source_value), CAST(measurement_date AS DATE)
            FROM read_csv_auto('{D}/r6263_measurement.csv') m
            JOIN cn ON cn.concept_id=m.measurement_concept_id
            LEFT JOIN cn u ON u.concept_id=m.unit_concept_id
            WHERE m.person_id={pid} AND CAST(measurement_date AS DATE) <= DATE '{index_date}'
              AND CAST(measurement_date AS DATE) >= DATE '{index_date}' - INTERVAL 2 YEAR
              AND value_as_number IS NOT NULL
            ORDER BY (CASE WHEN lower(cn.concept_name) LIKE '%platelet%' OR lower(cn.concept_name) LIKE '%aspartate%'
                        OR lower(cn.concept_name) LIKE '%alanine%' OR lower(cn.concept_name) LIKE '%bilirubin%'
                        OR lower(cn.concept_name) LIKE '%inr%' OR lower(cn.concept_name) LIKE '%prothrombin%'
                        OR lower(cn.concept_name) LIKE '%creatinine%' OR lower(cn.concept_name) LIKE '%sodium%'
                        OR lower(cn.concept_name) LIKE '%albumin%' OR lower(cn.concept_name) LIKE '%elastograph%'
                        OR lower(cn.concept_name) LIKE '%stiffness%' OR lower(cn.concept_name) LIKE '%meld%'
                      THEN 0 ELSE 1 END), CAST(measurement_date AS DATE) DESC""").fetchall()]

        procs = [dict(row_id=r[0], concept_name=r[1], cpt=r[2], date=str(r[3]))
          for r in con.execute(f"""SELECT procedure_occurrence_id, cn.concept_name, procedure_source_value,
              CAST(procedure_date AS DATE)
            FROM read_csv_auto('{D}/r6263_procedure_occurrence.csv') po JOIN cn ON cn.concept_id=po.procedure_concept_id
            WHERE po.person_id={pid} AND CAST(procedure_date AS DATE) <= DATE '{index_date}'
            ORDER BY 4""").fetchall()]

        obs = [dict(row_id=r[0], concept_name=r[1], value_as_string=r[2], date=str(r[3]))
          for r in con.execute(f"""SELECT observation_id, cn.concept_name, value_as_string,
              CAST(observation_date AS DATE)
            FROM read_csv_auto('{D}/r6263_observation.csv') o JOIN cn ON cn.concept_id=o.observation_concept_id
            WHERE o.person_id={pid} AND CAST(observation_date AS DATE) <= DATE '{index_date}'
              AND CAST(observation_date AS DATE) >= DATE '{index_date}' - INTERVAL 2 YEAR
            ORDER BY CAST(observation_date AS DATE) DESC""").fetchall()]

        encs = [dict(row_id=r[0], encounter_id=str(r[0]), type=r[1] or "Visit",
                     is_ed=bool(r[1] and "emergency" in r[1].lower()), start_date=str(r[2]), end_date=str(r[3]))
          for r in con.execute(f"""SELECT visit_occurrence_id, cn.concept_name,
              CAST(visit_start_date AS DATE), CAST(visit_end_date AS DATE)
            FROM read_csv_auto('{D}/r6263_visit_occurrence.csv') v LEFT JOIN cn ON cn.concept_id=v.visit_concept_id
            WHERE v.person_id={pid} AND CAST(visit_start_date AS DATE) <= DATE '{index_date}'
            ORDER BY 3""").fetchall()]

        notes = con.execute(f"""SELECT CAST(PHYSIOLOGIC_TIME AS DATE), SERVICE_NAME, REPORT_TEXT
            FROM read_parquet('{D}/notes/rdrp_6263-report-export-*.parquet')
            WHERE person_id={pid} AND CAST(PHYSIOLOGIC_TIME AS DATE) <= DATE '{index_date}'
              AND CAST(PHYSIOLOGIC_TIME AS DATE) >= DATE '{index_date}' - INTERVAL 5 YEAR
              AND REPORT_TEXT IS NOT NULL ORDER BY 1""").fetchall()
        if len(notes) > NOTE_CAP:
            pri = [n for n in notes if any(k in (n[1] or "").lower() for k in PRIORITY)]
            rest = [n for n in notes if n not in pri]
            notes = (pri + rest[-(NOTE_CAP - len(pri)):]) if len(pri) < NOTE_CAP else pri[:NOTE_CAP]
            notes.sort(key=lambda n: str(n[0]))
        used = set()
        for d_, svc, txt in notes:
            base = f"{d_}__{slug(svc)}"; fn = base; k = 2
            while fn in used: fn = f"{base}_{k}"; k += 1
            used.add(fn)
            open(os.path.join(pdir, "notes", fn + ".txt"), "w").write(str(txt))

        for name, data in [("conditions", conds), ("measurements", meas), ("procedures", procs),
                           ("observations", obs), ("encounters", encs),
                           ("demographics", [dict(row_id="dem1", age_at_index=age, sex=(sex or "")[:1] or None,
                                                  index_date=index_date)])]:
            json.dump(data, open(os.path.join(pdir, "omop", f"{name}.json"), "w"), indent=1, default=str)
        json.dump({"patient_id": anon, "category": "lcn_real", "phi": True,
                   "demographics": {"age": age, "sex": (sex or "")[:1] or None},
                   "index_date": index_date, "first_cirrhosis_code": first_cir,
                   "source": "OMOP ETL (liver-cp/scripts/lcn_etl.py) — real de-identified EHR (r6263)",
                   "note": "Real patient; PHI — gitignored. Chart filtered to date <= index_date. "
                           "Index = first cirrhosis code + 90d (pilot choice; study index design TBD)."},
                  open(os.path.join(pdir, "meta.json"), "w"), indent=2)
        print(f"[ok] {anon}  index={index_date}  notes={len(notes)} cond={len(conds)} meas={len(meas)} proc={len(procs)}")

if __name__ == "__main__":
    main()
