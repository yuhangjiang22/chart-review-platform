#!/usr/bin/env python3
"""LCN r6263 OMOP -> platform-corpus ETL.

Materializes real patients as corpus/patients/patient_real_lcn_<hash>/
{meta.json, omop/*.json, notes/*.txt} for the chart-review-lcn-cirrhosis task.

TWO MODES:

1. LEGACY (pilot): index = first cirrhosis condition + 90 days; chart is
   TRUNCATED to date <= index (notes 5y lookback, meas/obs 2y). The reference
   date the agent assesses "current" facts at IS the index date.
     python3 lcn_etl.py --patients 116800...,116800...

2. AUD-COHORT (forward-scan, per Dai Hao's plan + Compensated_CP_v2): index =
   the patient's FIRST-AUD date from the clean-cohort CSV; the chart is NOT
   truncated — the outcome (first date Step1+Step2 hold) lies AFTER index, so
   the full history through the end of data is materialized. meta carries
   both `index_date` (scan start) and `reference_date` (= last data activity;
   the date "current" assessments like MELD-Na/CTP refer to).
     python3 lcn_etl.py --cohort-csv ../docs/lcn_clean_cohort_local.csv \
         --patients 116800...,116800...

Real patients -> meta.phi=true (routes the agent to the HIPAA model).
"""
import argparse, csv, hashlib, json, os, re
import duckdb

D = "/Users/yj38/Documents/liver-cp/data"
DEFAULT_OUT = "/Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform/corpus/patients"
PRIORITY = ("radiol", "imaging", "ct ", "mri", "ultrasound", "endoscop", "gi ",
            "patholog", "hepatol", "gastro", "discharge", "operative")

def slug(s):
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", (s or "note").lower())).strip("_")[:40]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--patients", required=True)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--salt", default=os.environ.get("ETL_SALT", "rdrp6263"))
    ap.add_argument("--cohort-csv", help="clean-cohort CSV (AUD-index forward-scan mode)")
    ap.add_argument("--note-cap", type=int, default=40)
    ap.add_argument("--signals-csv", help="lcn_step1_signal_scan.csv — signal dates guide note selection")
    a = ap.parse_args()
    pids = [p.strip() for p in a.patients.split(",") if p.strip()]
    con = duckdb.connect()
    con.execute("PRAGMA threads=4; PRAGMA memory_limit='6GB'; PRAGMA temp_directory='/private/tmp/duck_tmp'")
    con.execute(f"CREATE VIEW cn AS SELECT concept_id, concept_name FROM read_csv_auto('{D}/r6263_concept.csv')")
    inlist = ",".join(pids)

    signals = {}
    if a.signals_csv:
        from datetime import date as _date
        for r in csv.DictReader(open(a.signals_csv)):
            ds = [r.get(k) for k in ("first_cirr_code_post","first_plt_low","first_stiff","first_img_kw","first_varices","coactivation_date")]
            signals[r["person_id"]] = [_date.fromisoformat(d) for d in ds if d]
    aud = {}
    if a.cohort_csv:
        for r in csv.DictReader(open(a.cohort_csv)):
            if str(r.get("clean", "true")).lower() == "true":
                aud[r["person_id"]] = str(r["index_date"])[:10]
        missing = [p for p in pids if p not in aud]
        if missing:
            raise SystemExit(f"[etl] {len(missing)} requested patients not in the CLEAN cohort: {missing[:3]}…")

    # legacy index: first cirrhosis condition + 90d
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
        first_cir = idx.get(pid, (None, None))[0]
        if a.cohort_csv:
            index_date = aud[pid]
            cut = ""          # no truncation — full history
            meas_lo = obs_lo = notes_lo = ""
        else:
            if pid not in idx:
                print(f"[skip] {pid}: no cirrhosis code"); continue
            index_date = idx[pid][1]
            cut = f"<= DATE '{index_date}'"
            meas_lo = obs_lo = f">= DATE '{index_date}' - INTERVAL 2 YEAR"
            notes_lo = f">= DATE '{index_date}' - INTERVAL 5 YEAR"
        yob, sex = person.get(pid, (None, None))
        age = int(index_date[:4]) - int(yob) if yob else None
        anon = "patient_real_lcn_" + hashlib.sha256((a.salt + pid).encode()).hexdigest()[:12]
        pdir = os.path.join(a.out, anon)
        import shutil
        for sub in ("omop", "notes"):          # re-materialization must not mix runs
            shutil.rmtree(os.path.join(pdir, sub), ignore_errors=True)
            os.makedirs(os.path.join(pdir, sub))

        def W(col):  # date-filter fragment
            parts = []
            if cut: parts.append(f"CAST({col} AS DATE) {cut}")
            return (" AND " + " AND ".join(parts)) if parts else ""

        conds = [dict(zip(("row_id","concept_id","concept_name","date","source_value"), r)) for r in con.execute(f"""
            SELECT condition_occurrence_id, condition_concept_id, cn.concept_name,
                   CAST(condition_start_date AS DATE), condition_source_value
            FROM read_csv_auto('{D}/r6263_condition_occurrence.csv') co
            LEFT JOIN cn ON cn.concept_id = co.condition_concept_id
            WHERE co.person_id={pid}{W('condition_start_date')} ORDER BY 4""").fetchall()]
        lo = f" AND CAST(measurement_date AS DATE) {meas_lo}" if meas_lo else ""
        if a.cohort_csv:
            # rubric-relevant labs only: crit B (stiffness), crit D (platelets),
            # CTP (bilirubin/albumin/INR), MELD-Na (+creatinine/sodium), FIB-4 (AST/ALT).
            lo += (" AND regexp_matches(lower(cn.concept_name),"
                   " 'platelet|elastogr|stiffness|bilirubin|albumin|prothrombin"
                   "|creatinine|sodium|aspartate|alanine|meld"
                   "|(^|[^a-z])inr([^a-z]|$)|international normalized')")
        meas = [dict(zip(("row_id","concept_id","concept_name","date","value","unit"), r)) for r in con.execute(f"""
            SELECT measurement_id, measurement_concept_id, cn.concept_name,
                   CAST(measurement_date AS DATE), value_as_number, unit_source_value
            FROM read_csv_auto('{D}/r6263_measurement.csv') m
            LEFT JOIN cn ON cn.concept_id = m.measurement_concept_id
            WHERE m.person_id={pid}{W('measurement_date')}{lo}
              AND m.value_as_number IS NOT NULL ORDER BY 4""").fetchall()]
        procs = [dict(zip(("row_id","concept_id","concept_name","date","source_value"), r)) for r in con.execute(f"""
            SELECT procedure_occurrence_id, procedure_concept_id, cn.concept_name,
                   CAST(procedure_date AS DATE), procedure_source_value
            FROM read_csv_auto('{D}/r6263_procedure_occurrence.csv') po
            LEFT JOIN cn ON cn.concept_id = po.procedure_concept_id
            WHERE po.person_id={pid}{W('procedure_date')} ORDER BY 4""").fetchall()]
        lo = f" AND CAST(observation_date AS DATE) {obs_lo}" if obs_lo else ""
        obs = [dict(zip(("row_id","concept_id","concept_name","date","value"), r)) for r in con.execute(f"""
            SELECT observation_id, observation_concept_id, cn.concept_name,
                   CAST(observation_date AS DATE), COALESCE(value_as_string, CAST(value_as_number AS VARCHAR))
            FROM read_csv_auto('{D}/r6263_observation.csv') o
            LEFT JOIN cn ON cn.concept_id = o.observation_concept_id
            WHERE o.person_id={pid}{W('observation_date')} ORDER BY 4""").fetchall()]
        encs = [dict(zip(("row_id","concept_id","type","start_date","end_date"), r)) for r in con.execute(f"""
            SELECT visit_occurrence_id, visit_concept_id, cn.concept_name,
                   CAST(visit_start_date AS DATE), CAST(visit_end_date AS DATE)
            FROM read_csv_auto('{D}/r6263_visit_occurrence.csv') v
            LEFT JOIN cn ON cn.concept_id = v.visit_concept_id
            WHERE v.person_id={pid}{W('visit_start_date')} ORDER BY 4""").fetchall()]
        lo = f" AND CAST(PHYSIOLOGIC_TIME AS DATE) {notes_lo}" if notes_lo else ""
        notes = con.execute(f"""SELECT CAST(PHYSIOLOGIC_TIME AS DATE), SERVICE_NAME, REPORT_TEXT
            FROM read_parquet('{D}/notes/rdrp_6263-report-export-*.parquet')
            WHERE person_id={pid}{W('PHYSIOLOGIC_TIME')}{lo}
              AND REPORT_TEXT IS NOT NULL ORDER BY 1""").fetchall()
        if len(notes) > a.note_cap:
            sig = signals.get(pid, [])
            if sig:
                # signal-guided: rank by distance to the nearest signal date,
                # then by priority type — evidence-dense regions of the chart win.
                def score(n):
                    nd = n[0]
                    dist = min(abs((nd - sd).days) for sd in sig)
                    pri = 0 if any(k in (n[1] or "").lower() for k in PRIORITY) else 1
                    return (dist, pri, str(nd))
                notes = sorted(notes, key=score)[:a.note_cap]
            else:
                pri = [n for n in notes if any(k in (n[1] or "").lower() for k in PRIORITY)]
                rest = [n for n in notes if n not in pri]
                notes = (pri + rest[-(a.note_cap - len(pri)):]) if len(pri) < a.note_cap else pri[:a.note_cap]
            notes.sort(key=lambda n: str(n[0]))
        used = set()
        for d_, svc, txt in notes:
            base = f"{d_}__{slug(svc)}"; fn = base; k = 2
            while fn in used: fn = f"{base}_{k}"; k += 1
            used.add(fn)
            open(os.path.join(pdir, "notes", fn + ".txt"), "w").write(str(txt))

        if a.cohort_csv:
            # computed FOUNDATIONS (positive-only pointers; absent when none):
            # the agent verifies + cites the underlying measurements row.
            plt_low = sorted((r for r in meas if "platelet" in (r["concept_name"] or "").lower()
                              and "mean" not in (r["concept_name"] or "").lower()
                              and "distribution" not in (r["concept_name"] or "").lower()
                              and "plasma" not in (r["concept_name"] or "").lower()
                              and r["value"] is not None and float(r["value"]) < 150 and float(r["value"]) > 1),
                             key=lambda r: str(r["date"]))
            stiff_rows = sorted((r for r in meas if any(k in (r["concept_name"] or "").lower()
                                for k in ("elastogr", "stiffness"))), key=lambda r: str(r["date"]))
            fnd = []
            if plt_low:
                r0 = plt_low[0]
                fnd.append(dict(row_id="fnd_plt", concept_id=0,
                    concept_name="Earliest platelet <150 [computed foundation - verify in measurements]",
                    value=f"{r0['date']} (value {r0['value']}, measurements row {r0['row_id']}; {len(plt_low)} qualifying rows total)",
                    date=r0["date"]))
            if stiff_rows:
                r0 = stiff_rows[0]
                fnd.append(dict(row_id="fnd_stiff", concept_id=0,
                    concept_name="Earliest liver-stiffness measurement [computed foundation - verify in measurements]",
                    value=f"{r0['date']} (value {r0['value']}, measurements row {r0['row_id']})",
                    date=r0["date"]))
            obs = fnd + obs
        all_dates = [str(r["date"]) for r in conds + meas + procs + obs if r.get("date")] + \
                    [str(r["start_date"]) for r in encs if r.get("start_date")] + \
                    [str(n[0]) for n in notes]
        reference_date = max(all_dates)[:10] if all_dates else index_date

        demo = dict(row_id="dem1", age_at_index=age, sex=(sex or "")[:1] or None,
                    index_date=index_date)
        if a.cohort_csv: demo["reference_date"] = reference_date
        for name, data in [("conditions", conds), ("measurements", meas), ("procedures", procs),
                           ("observations", obs), ("encounters", encs), ("demographics", [demo])]:
            json.dump(data, open(os.path.join(pdir, "omop", f"{name}.json"), "w"), indent=1, default=str)
        meta = {"patient_id": anon, "category": "lcn_real", "phi": True,
                "demographics": {"age": age, "sex": (sex or "")[:1] or None},
                "index_date": index_date, "first_cirrhosis_code": first_cir,
                "source": "OMOP ETL (liver-cp/scripts/lcn_etl.py) — real de-identified EHR (r6263)"}
        if a.cohort_csv:
            meta["reference_date"] = reference_date
            meta["index_semantics"] = "first-AUD (clean cohort); chart NOT truncated; outcome scan runs FORWARD from index to reference_date"
            meta["note"] = "Real patient; PHI — gitignored. Full history materialized (AUD-cohort mode)."
        else:
            meta["note"] = ("Real patient; PHI — gitignored. Chart filtered to date <= index_date. "
                            "Index = first cirrhosis code + 90d (pilot choice; study index design TBD).")
        json.dump(meta, open(os.path.join(pdir, "meta.json"), "w"), indent=2)
        print(f"[ok] {anon}  index={index_date}  ref={reference_date if a.cohort_csv else index_date}  "
              f"notes={len(notes)} cond={len(conds)} meas={len(meas)} proc={len(procs)}")

if __name__ == "__main__":
    main()
