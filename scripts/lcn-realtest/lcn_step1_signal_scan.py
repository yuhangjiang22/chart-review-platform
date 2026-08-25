#!/usr/bin/env python3
"""LCN rule-based Step-1 signal scan over the CLEAN AUD cohort (forward from index).

For every clean-cohort person (index = first AUD), collects DATED structured/
keyword signals that correspond to the Step-1 criteria, then computes whether
>=2 distinct signal types' activation windows CO-OVERLAP at some t in
[index, last_activity] — the rule layer's estimate of the earliest possible
Step-1 date. This is a SCREEN for agent review, not a verdict: keyword hits
include negations and the agent verifies everything.

Signal types and windows (mirror Table 2):
  plt      platelet count <150 (measurements; MPV/PDW excluded)      +183d
  stiff    elastography / liver-stiffness measurement                +365d
  img_kw   note containing nodular AND splenomegaly                  +365d
  varices  varices condition code OR note keyword                    +1095d
Cirrhosis condition codes are tracked separately (screen A - strong prior
that chartable Step-1 evidence exists) but are NOT a Table-2 criterion.

Output: docs/lcn_step1_signal_scan.csv (one row per clean person, ids local
only). Prints aggregate counts.
"""
import duckdb, csv
from datetime import date, timedelta

LP  = "/Users/yj38/Documents/liver-cp"
IN  = f"{LP}/docs/lcn_clean_cohort_local.csv"
OUT = f"{LP}/docs/lcn_step1_signal_scan.csv"
WIN = {"plt": 183, "stiff": 365, "img_kw": 365, "varices": 1095}

con = duckdb.connect()
con.execute("PRAGMA threads=4; PRAGMA memory_limit='6GB'; PRAGMA temp_directory='/private/tmp/duck_tmp'")
con.execute(f"""CREATE TABLE coh AS
  SELECT CAST(person_id AS VARCHAR) pid, CAST(index_date AS DATE) ix
  FROM read_csv_auto('{IN}') WHERE clean""")
n = con.execute("SELECT count(*) FROM coh").fetchone()[0]
con.execute(f"CREATE VIEW cn AS SELECT concept_id, concept_name FROM read_csv_auto('{LP}/data/r6263_concept.csv')")

def dated(sql):
    out = {}
    for pid, d in con.execute(sql).fetchall():
        out.setdefault(str(pid), []).append(d)
    return out

plt = dated(f"""
  SELECT m.person_id, CAST(m.measurement_date AS DATE)
  FROM read_csv_auto('{LP}/data/r6263_measurement.csv') m
  JOIN cn ON cn.concept_id = m.measurement_concept_id
  JOIN coh ON CAST(coh.pid AS VARCHAR) = CAST(m.person_id AS VARCHAR)
  WHERE lower(cn.concept_name) LIKE '%platelet%'
    AND lower(cn.concept_name) NOT LIKE '%mean platelet%'
    AND lower(cn.concept_name) NOT LIKE '%distribution%'
    AND lower(cn.concept_name) NOT LIKE '%plasma%'
    AND m.value_as_number IS NOT NULL AND m.value_as_number < 150 AND m.value_as_number > 1""")
stiff = dated(f"""
  SELECT m.person_id, CAST(m.measurement_date AS DATE)
  FROM read_csv_auto('{LP}/data/r6263_measurement.csv') m
  JOIN cn ON cn.concept_id = m.measurement_concept_id
  JOIN coh ON CAST(coh.pid AS VARCHAR) = CAST(m.person_id AS VARCHAR)
  WHERE lower(cn.concept_name) LIKE '%elastograph%' OR lower(cn.concept_name) LIKE '%stiffness%'""")
cirr = dated(f"""
  SELECT co.person_id, CAST(co.condition_start_date AS DATE)
  FROM read_csv_auto('{LP}/data/r6263_condition_occurrence.csv') co
  JOIN cn ON cn.concept_id = co.condition_concept_id
  JOIN coh ON CAST(coh.pid AS VARCHAR) = CAST(co.person_id AS VARCHAR)
  WHERE lower(cn.concept_name) LIKE '%cirrhosis%'""")
var_code = dated(f"""
  SELECT co.person_id, CAST(co.condition_start_date AS DATE)
  FROM read_csv_auto('{LP}/data/r6263_condition_occurrence.csv') co
  JOIN cn ON cn.concept_id = co.condition_concept_id
  JOIN coh ON CAST(coh.pid AS VARCHAR) = CAST(co.person_id AS VARCHAR)
  WHERE lower(cn.concept_name) LIKE '%varice%'""")
img_kw = dated(f"""
  SELECT nt.person_id, CAST(nt.PHYSIOLOGIC_TIME AS DATE)
  FROM read_parquet('{LP}/data/notes/rdrp_6263-report-export-*.parquet') nt
  JOIN coh ON CAST(coh.pid AS VARCHAR) = CAST(nt.person_id AS VARCHAR)
  WHERE regexp_matches(lower(nt.REPORT_TEXT), 'nodular') AND regexp_matches(lower(nt.REPORT_TEXT), 'splenomegaly')""")
var_kw = dated(f"""
  SELECT nt.person_id, CAST(nt.PHYSIOLOGIC_TIME AS DATE)
  FROM read_parquet('{LP}/data/notes/rdrp_6263-report-export-*.parquet') nt
  JOIN coh ON CAST(coh.pid AS VARCHAR) = CAST(nt.person_id AS VARCHAR)
  WHERE regexp_matches(lower(nt.REPORT_TEXT), 'varices')""")
last_act = {str(r[0]): r[1] for r in con.execute(f"""
  SELECT v.person_id, MAX(CAST(v.visit_start_date AS DATE))
  FROM read_csv_auto('{LP}/data/r6263_visit_occurrence.csv') v
  JOIN coh ON CAST(coh.pid AS VARCHAR) = CAST(v.person_id AS VARCHAR) GROUP BY 1""").fetchall()}
n_notes = {str(r[0]): r[1] for r in con.execute(f"""
  SELECT nt.person_id, count(*)
  FROM read_parquet('{LP}/data/notes/rdrp_6263-report-export-*.parquet') nt
  JOIN coh ON CAST(coh.pid AS VARCHAR) = CAST(nt.person_id AS VARCHAR) GROUP BY 1""").fetchall()}

rows = []
stats = {"screenA_cirr_code": 0, "screenB_coactive": 0, "either": 0}
for pid, ix in con.execute("SELECT pid, ix FROM coh").fetchall():
    pid = str(pid)
    end = last_act.get(pid) or ix
    sigs = {"plt": plt.get(pid, []), "stiff": stiff.get(pid, []),
            "img_kw": img_kw.get(pid, []),
            "varices": sorted(set(var_code.get(pid, []) + var_kw.get(pid, [])))}
    # co-activation: earliest t in [ix, end] where >=2 distinct types active
    events = []
    for typ, dates in sigs.items():
        for d in dates:
            lo, hi = d, d + timedelta(days=WIN[typ])
            if hi < ix or lo > end: continue
            events.append((max(lo, ix), typ, "on"))
            events.append((hi, typ, "off"))
    coact = None
    active = {}
    for t, typ, kind in sorted(events, key=lambda e: (e[0], e[2] == "off")):
        if kind == "on":
            active[typ] = active.get(typ, 0) + 1
            if len([k for k, v in active.items() if v > 0]) >= 2:
                coact = max(t, ix); break
        else:
            active[typ] = active.get(typ, 0) - 1
            if active[typ] <= 0: active.pop(typ, None)
    cirr_post = [d for d in cirr.get(pid, []) if d >= ix - timedelta(days=90)]
    a = bool(cirr_post); b = coact is not None
    stats["screenA_cirr_code"] += a
    stats["screenB_coactive"] += b
    stats["either"] += (a or b)
    def f1(x): return str(min(x)) if x else ""
    rows.append(dict(
        person_id=pid, index_date=str(ix), last_activity=str(end),
        first_cirr_code_post=f1(cirr_post),
        first_plt_low=f1([d for d in sigs["plt"] if d >= ix - timedelta(days=WIN["plt"])]),
        first_stiff=f1([d for d in sigs["stiff"] if d >= ix - timedelta(days=WIN["stiff"])]),
        first_img_kw=f1([d for d in sigs["img_kw"] if d >= ix - timedelta(days=WIN["img_kw"])]),
        first_varices=f1([d for d in sigs["varices"] if d >= ix - timedelta(days=WIN["varices"])]),
        coactivation_date=str(coact) if coact else "",
        n_notes=n_notes.get(pid, 0),
        screenA=int(a), screenB=int(b), candidate=int(a or b)))

with open(OUT, "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)

print(f"[scan] clean cohort                              : {n}")
print(f"[scan] screen A — cirrhosis code >= index-90d    : {stats['screenA_cirr_code']}")
print(f"[scan] screen B — >=2 signal windows co-active   : {stats['screenB_coactive']}")
print(f"[scan] CANDIDATES for agent review (A or B)      : {stats['either']}")
import statistics
co=[r for r in rows if r["coactivation_date"]]
if co:
    lead=[ (date.fromisoformat(r["coactivation_date"]) - date.fromisoformat(r["index_date"])).days for r in co]
    print(f"[scan] coactivation lead over index (days): median={int(statistics.median(lead))} min={min(lead)} max={max(lead)}")
nn=[r["n_notes"] for r in rows if r["candidate"]]
if nn: print(f"[scan] candidate note volume: median={int(statistics.median(nn))} max={max(nn)}")
print(f"[scan] -> {OUT}")
