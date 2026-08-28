#!/usr/bin/env python3
"""
etl.py — Asthma-adherence OMOP → platform-corpus ETL.

Runs the OHDSI-SQL files (cohort.sql / extracts.sql / conformance.sql) which are
the portable source of truth. This runner renders them for DuckDB (a STAND-IN for
OHDSI SqlRender so we can validate on the RDRP files); AT YOUR SITE render with
real OHDSI SqlRender instead:
    SqlRender::translate(SqlRender::render(readr::read_file('cohort.sql'),
        cdm_database_schema='omop_cdm', min_age=2, max_age=17,
        min_asthma_encounters=2), targetDialect='postgresql')

Transform (Python, dialect-independent): drug→RxNorm-ingredient fills +
saba_canisters_12mo, conditions dedup + icd10cm parse, asthma_related, and the
v0.4 foundations. Load: corpus/patients/<anon>/{meta.json,omop/*.json,notes/*.txt}.

Usage (from concur root):
  pip install duckdb
  python3 scripts/asthma-omop-extract/etl.py --check \
      --rdrp /path/to/RDRP-6745 --notes "/path/to/RDRP-6745 Notes/r6745 Notes"
  python3 scripts/asthma-omop-extract/etl.py \
      --rdrp /path/to/RDRP-6745 --notes "/path/to/RDRP-6745 Notes/r6745 Notes" \
      --out corpus/patients --limit 25          # omit --limit for the whole cohort

Prints only counts/aggregates — never PHI.
"""
import argparse, hashlib, json, os, re, sys
from collections import defaultdict
from datetime import date
import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from derive_anchors import derive_for_patient
def load(n): return open(os.path.join(HERE, n)).read()
def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)   # block comments
    s = re.sub(r"--[^\n]*", "", s)                # line comments
    return s
def slug(s):
    s = re.sub(r"[^a-z0-9]+", "_", (s or "note").lower()).strip("_"); return s or "note"
def band(a): return "age_2_4" if a <= 4 else "age_5_11" if a <= 11 else "age_12_17"
def d12(idx):
    di = date.fromisoformat(idx[:10])
    try: return date(di.year-1, di.month, di.day).strftime("%Y-%m-%d")
    except ValueError: return date(di.year-1, di.month, 28).strftime("%Y-%m-%d")

DRUG_KW = {"albuterol":("SABA",False),"levalbuterol":("SABA",False),"fluticasone":("ICS",True),
 "budesonide":("ICS",True),"mometasone":("ICS",True),"beclomethasone":("ICS",True),"ciclesonide":("ICS",True),
 "salmeterol":("LABA",True),"formoterol":("LABA",True),"vilanterol":("LABA",True),
 "montelukast":("LTRA",True),"tiotropium":("LAMA",True),"omalizumab":("biologic",True),
 "mepolizumab":("biologic",True),"benralizumab":("biologic",True),"dupilumab":("biologic",True),
 "prednisone":("OCS",False),"prednisolone":("OCS",False),"methylprednisolone":("OCS",False),"dexamethasone":("OCS",False)}

# Study window on index_date (post-2020 default → 2020 NAEPP edition applies to all).
STUDY_START = "2021-01-01"
STUDY_END   = "2100-01-01"

def render_duckdb(sql, schema_prefix=""):
    """Stand-in for OHDSI SqlRender: substitute @params + translate the OHDSI
       functions we use to DuckDB. A real site uses SqlRender.translate() instead."""
    s = strip_comments(sql)
    s = s.replace("@cdm_database_schema.", schema_prefix)
    s = s.replace("@cohort_table", "cohort").replace("@drug_class_table", "drug_class_map")
    s = s.replace("@min_age", "2").replace("@max_age", "17").replace("@min_asthma_encounters", "2").replace("@min_prior_observation_days", "365")
    # 0 = no note floor, matching cohort.sql's default. The local corpus is the
    # place to see the n_notes_12mo distribution, not to filter on it.
    s = s.replace("@min_notes_12mo", "0")
    s = s.replace("@study_start", STUDY_START).replace("@study_end", STUDY_END)
    s = re.sub(r"DATEADD\(MONTH,\s*-12,\s*([^)]+)\)", r"(\1 - INTERVAL 12 MONTH)", s)
    s = re.sub(r"DATEADD\(DAY,\s*-(\d+),\s*([^)]+)\)", r"(\2 - INTERVAL \1 DAY)", s)
    s = re.sub(r"DATEDIFF\(DAY,\s*([^,]+),\s*([^)]+)\)", r"DATE_DIFF('day', \1, \2)", s)
    return s

def named_blocks(sql):
    out = {}
    for chunk in sql.split("-- ==NAME ")[1:]:
        name = chunk.split("==", 1)[0].strip()
        body = chunk.split("==", 1)[1]
        body = body.split("\n", 1)[1] if "\n" in body else body  # drop trailing comment on marker line
        out[name] = render_duckdb(body)
    return out

def setup_adapter(con, adapter_path, rdrp, notes):
    adapter = open(adapter_path).read().replace("{RD}", rdrp).replace("{RD_NOTES}", notes)
    for stmt in [x.strip() for x in strip_comments(adapter).split(";") if x.strip()]:
        con.execute(stmt)
    ings = con.execute("SELECT concept_id, lower(concept_name) FROM concept "
                       "WHERE concept_class_id='Ingredient' AND vocabulary_id='RxNorm'").fetchall()
    con.execute("CREATE TABLE drug_class_map(ingredient_concept_id BIGINT, drug_class VARCHAR, is_controller BOOLEAN)")
    rows = []
    for cid, nm in ings:
        for k, (cls, ctrl) in DRUG_KW.items():
            if k in nm: rows.append((cid, cls, ctrl)); break
    con.executemany("INSERT INTO drug_class_map VALUES (?,?,?)", rows)

def roll_up_drugs(drug_rows, lo, idx):
    """Group a patient's drug_exposure rows by RxNorm ingredient and derive the
       12-month fields. Extracted from the ETL loop so it can be tested without a
       database — see test_derive_anchors.py's precedent.

       `lo` / `idx` bound the window as (lo, idx]: lo is index_date minus 12
       months, so a fill exactly 12 months before the index date is OUT."""
    dby = {}
    for r in drug_rows:
        e = dby.setdefault(r["concept_id"], {"row_id": f"drg{r['row_id']}", "concept_id": r["concept_id"],
             "concept_name": r["concept_name"], "rxnorm": r["rxnorm"], "drug_class": r["drug_class"],
             "is_controller": bool(r["is_controller"]), "fills": []})
        e["fills"].append({"fill_date": str(r["fill_date"])[:10], "days_supply": r["days_supply"], "quantity": r["quantity"]})
    drugs = []; saba = 0; saba_qty = 0.0; saba_qty_seen = False
    for e in dby.values():
        e["fills"].sort(key=lambda x: x["fill_date"]); e["start_date"] = e["fills"][0]["fill_date"]; e["n_fills"] = len(e["fills"])
        inwin = [f for f in e["fills"] if lo < f["fill_date"] <= idx]
        # SABA "canisters" counts FILLS, not inhaler units. One dispensing = one
        # canister is the HEDIS AMR operational proxy, and here it is the only
        # thing available: drug_exposure.quantity is null on ALL 6,653 fills of
        # every class (measured across the 63 extracted patients). quantity is
        # still summed when the source carries it, but it does NOT become the
        # number — a future drop could report grams (8.5) or actuations (200)
        # rather than units, and guessing the units would inflate a >= 3
        # threshold into a care gap the data does not support. Whoever gets a
        # drop with quantity reads saba_quantity_12mo, decides what its units
        # are, and changes this deliberately.
        if e["drug_class"] == "SABA":
            saba += len(inwin)
            for f in inwin:
                if f["quantity"] is not None:
                    saba_qty_seen = True; saba_qty += float(f["quantity"])
        # PDC over the fills that HAVE a days_supply. `or 0` silently treated a
        # null as zero coverage, so a drug with 9 documented fills and 1 null one
        # reported less coverage than it had — understating adherence, the same
        # one-directional bias as a missing answer. days_supply is present on
        # ~15% of SABA and ~17% of ICS fills here, so partial denominators are
        # the norm; the conformance WARN claiming PDC "won't compute" below 50%
        # is only true for a drug whose in-window fills are ALL null.
        with_ds = [f for f in inwin if f["days_supply"] is not None]
        cov = sum(f["days_supply"] for f in with_ds)
        if e["is_controller"] and cov > 0:
            e["refill_pdc_12mo"] = round(min(1.0, cov/365.0), 2)
            if len(with_ds) < len(inwin):
                e["refill_pdc_partial"] = (
                    f"{len(inwin) - len(with_ds)} of {len(inwin)} in-window fills "
                    f"have no days_supply — this PDC is a floor, not a rate")
        drugs.append(e)
    for e in drugs:
        if e["drug_class"] == "SABA":
            e["saba_canisters_12mo"] = saba
            e["saba_canisters_basis"] = "fills"
            if saba_qty_seen: e["saba_quantity_12mo"] = round(saba_qty, 2)
    return drugs


def conformance(con):
    THRESH = {  # name: (fail_below, warn_below, note)
      "asthma_concepts":(1,1,"vocabulary must resolve SNOMED 317009"),
      "visit_mapping_pct":(1,80,"% visits mapped to 9201/9202/9203"),
      "notes_populated":(1,1,"note table must have text (else agents have no chart)"),
      # NOT "won't compute": PDC computes from whatever fills DO carry a
      # days_supply, so a low rate here means partial denominators, which the
      # per-drug refill_pdc_partial marker flags. The SABA count is unaffected
      # (it counts fills, not supply).
      "days_supply_pct":(0,50,"<50% → refill_pdc_12mo is a floor, flagged refill_pdc_partial"),
      "act_structured":(0,1,"0 → ACT is note-only here (like INPC)"),
      "drug_ingredient_rollup":(1,1,"drugs must roll up to RxNorm ingredients")}
    print("=== conformance (site readiness) ===")
    for name, q in named_blocks(load("conformance.sql")).items():
        try: v = con.execute(q).fetchone()[0]
        except Exception as e: print(f"  {name:24} ERROR ({str(e)[:40]}) — table missing?"); continue
        v = 0 if v is None else v
        fail, warn, note = THRESH.get(name, (0,0,""))
        status = "FAIL" if v < fail else ("WARN" if v < warn else "PASS")
        print(f"  {name:24} {str(round(v,1)):>10}   {status:4}  {note}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rdrp", required=True); ap.add_argument("--notes", required=True)
    ap.add_argument("--out", default="corpus/patients"); ap.add_argument("--limit", type=int)
    ap.add_argument("--patients"); ap.add_argument("--salt", default=os.environ.get("ETL_SALT","rdrp6745"))
    ap.add_argument("--prefix", default="patient_real_asthma_"); ap.add_argument("--check", action="store_true")
    ap.add_argument("--adapter", default=os.path.join(HERE,"adapter_rdrp.sql"))
    ap.add_argument("--study-start", default="2021-01-01", help="index_date >= this (post-2020 = 2020 NAEPP edition)")
    ap.add_argument("--study-end", default="2100-01-01", help="index_date <= this")
    a = ap.parse_args()
    global STUDY_START, STUDY_END
    STUDY_START, STUDY_END = a.study_start, a.study_end
    con = duckdb.connect(); setup_adapter(con, a.adapter, a.rdrp, a.notes)
    if a.check: conformance(con); return

    # cohort → table (limit/patients filter here so extracts join only these)
    where = ""
    if a.patients: where = " WHERE person_id IN (" + ",".join(f"'{p}'" for p in a.patients.split(",")) + ")"
    lim = f" LIMIT {a.limit}" if a.limit else ""
    coh = render_duckdb(load("cohort.sql")).strip().rstrip(";")
    con.execute(f"CREATE TABLE cohort AS SELECT * FROM ({coh}) t{where}{lim}")
    cohort = con.execute("SELECT person_id, CAST(index_date AS VARCHAR), age_at_index FROM cohort").fetchall()
    print(f"[etl] cohort rows to extract: {len(cohort)}")
    pmeta = {r[0]: {"idx": r[1][:10], "age": r[2]} for r in cohort}
    demo = {r[0]: r[1:] for r in con.execute("SELECT person_id, year_of_birth, gender_concept_id FROM person").fetchall()}

    # run extracts (all cohort patients at once) → group by person_id
    blk = named_blocks(load("extracts.sql"))
    def grouped(name):
        g = defaultdict(list); cols = [d[0] for d in con.execute(blk[name]).description]
        for row in con.execute(blk[name]).fetchall(): g[row[0]].append(dict(zip(cols, row)))
        return g
    G = {t: grouped(t) for t in ["conditions","drugs","asthma_visits","encounters","measurements","procedures","notes"]}

    n = 0
    for pid, m in pmeta.items():
        idx = m["idx"]; lo = d12(idx); age = int(idx[:4]) - demo[pid][0]
        sex = {8507:"M",8532:"F"}.get(demo[pid][1], "U")
        # conditions: dedup by concept, earliest, parse icd10
        cbyc = {}
        for r in G["conditions"].get(pid, []):
            d = str(r["date"])[:10]; cid = r["concept_id"]
            if cid not in cbyc or d < cbyc[cid]["date"]:
                icd = re.search(r"([A-Z][0-9]{2}\.?[0-9A-Z]*)", r.get("condition_source_value") or "")
                cbyc[cid] = {"row_id": r["row_id"], "concept_id": cid, "concept_name": r["concept_name"],
                             "icd10cm": icd.group(1) if icd else None, "status": "active", "date": d}
        conditions = sorted(cbyc.values(), key=lambda x: x["date"])
        drugs = roll_up_drugs(G["drugs"].get(pid, []), lo, idx)
        # asthma_related sets
        avid = {str(r["vid"]) for r in G["asthma_visits"].get(pid, [])}
        adate = {str(r["d"])[:10] for r in G["asthma_visits"].get(pid, [])}
        enc = []
        for r in G["encounters"].get(pid, []):
            typ = {9201:"Inpatient Visit",9202:"Outpatient Visit",9203:"Emergency Room Visit"}.get(r["visit_concept_id"], "Visit")
            sd = str(r["start_date"])[:10]
            enc.append({"row_id": r["row_id"], "encounter_id": r["row_id"], "type": typ,
                        "is_ed": r["visit_concept_id"] == 9203,
                        "asthma_related": (str(r["row_id"]) in avid) or (sd in adate),
                        # PROVENANCE of the flag above, which is otherwise
                        # unrecoverable downstream (conditions.json drops
                        # visit_occurrence_id when it dedups by concept).
                        #
                        # `asthma_related` is deliberately permissive: 8.0% of
                        # J45 condition rows in this extract carry no
                        # visit_occurrence_id, so a visit-link-only test would
                        # discard real asthma visits. The date fallback rescues
                        # them — and also flags every OTHER visit that day, which
                        # in this extract is 331,596 encounters that had nothing
                        # to do with asthma.
                        #
                        # derive_anchors collapses same-day encounters, so the
                        # noise costs no extra anchors. It DID cost the anchor's
                        # setting label: `meta.kind` was decided over every
                        # flagged encounter that day, so an asthma ED visit
                        # sharing a date with an unrelated clinic appointment was
                        # labelled OUTPATIENT — 6,322 of the 30,257 ED-only
                        # asthma days (21%). That label carries the study's
                        # per-setting stratification. This field lets the setting
                        # be decided from the encounters that actually carry the
                        # diagnosis.
                        "asthma_dx_linked": str(r["row_id"]) in avid,
                        "start_date": sd, "end_date": str(r["end_date"])[:10] if r["end_date"] else None})
        enc.sort(key=lambda x: x["start_date"])
        measurements = sorted([{"row_id":r["row_id"],"concept_id":r["concept_id"],"concept_name":r["concept_name"],
                                "value_as_number":r["value_as_number"],"unit":r["unit"],"date":str(r["date"])[:10]}
                               for r in G["measurements"].get(pid, [])], key=lambda x: x["date"])
        procedures = sorted([{"row_id":r["row_id"],"concept_id":r["concept_id"],"concept_name":r["concept_name"],
                              "cpt":r["cpt"],"date":str(r["date"])[:10]} for r in G["procedures"].get(pid, [])], key=lambda x: x["date"])
        op12 = sum(1 for e in enc if not e["is_ed"] and e["type"]=="Outpatient Visit" and lo < e["start_date"] <= idx)
        # v0.5 foundations: ASTHMA-RELATED encounters (study-plan inclusion
        # wording: ">= 2 asthma-related encounters"). Only inpatient is
        # excluded — primary care, specialty, urgent care AND ED all count
        # (clinical reviewers: urgent care / stand-alone ED lines blur).
        # Eligibility floor (Fedele): >= 1 of them must be outpatient (non-ED).
        enc12_asthma = sum(1 for e in enc if "Inpatient" not in e["type"]
                           and e["asthma_related"] and lo < e["start_date"] <= idx)
        op12_asthma = sum(1 for e in enc if not e["is_ed"] and "Inpatient" not in e["type"]
                          and e["asthma_related"] and lo < e["start_date"] <= idx)
        ctrl_active = any(e["is_controller"] and any(lo < f["fill_date"] <= idx for f in e["fills"]) for e in drugs)
        exac = set()
        for e in enc:
            if e["asthma_related"] and (e["is_ed"] or "Inpatient" in e["type"]) and lo < e["start_date"] <= idx: exac.add(e["start_date"])
        for e in drugs:
            if e["drug_class"] == "OCS":
                for f in e["fills"]:
                    if lo < f["fill_date"] <= idx: exac.add(f["fill_date"])
        # 14-day event separation (clinical reviewers, Blake RCT definition):
        # a new exacerbation only when >14 days from the previous event's start;
        # markers within 14 days (second OCS course, ED visit + discharge
        # steroids) are the SAME prolonged/undertreated exacerbation.
        from datetime import date as _date
        exac_events, last_start = 0, None
        for d_ in (_date.fromisoformat(s) for s in sorted(exac)):
            if last_start is None or (d_ - last_start).days > 14:
                exac_events += 1; last_start = d_
        demographics = [{"row_id":"dem1","age_at_index":age,"age_band":band(age),"sex":sex,
                         "lookback_outpatient_count_12mo":op12,
                         "lookback_asthma_encounter_count_12mo":enc12_asthma,
                         "lookback_asthma_outpatient_count_12mo":op12_asthma,
                         "index_date":idx}]
        # controller_active is only trustworthy when dispensing data exists;
        # an empty drugs table must NOT produce a confident false (v0.5 audit:
        # 6/30 patients had note-only controllers hidden by this shortcut).
        if drugs: demographics[0]["controller_active"] = ctrl_active
        observations = [{"row_id":"exa1","concept_id":9990001,"concept_name":"Asthma exacerbations, past 12 months (computed, 14-day event separation)",
                         "value_as_number":exac_events,"date":idx}]
        # write
        anon = a.prefix + hashlib.sha256((a.salt + str(pid)).encode()).hexdigest()[:12]
        pdir = os.path.join(a.out, anon); os.makedirs(os.path.join(pdir,"omop"), exist_ok=True); os.makedirs(os.path.join(pdir,"notes"), exist_ok=True)
        for t, data in [("conditions",conditions),("drugs",drugs),("observations",observations),
                        ("measurements",measurements),("encounters",enc),("procedures",procedures),("demographics",demographics)]:
            json.dump(data, open(os.path.join(pdir,"omop",f"{t}.json"),"w"), indent=2, default=str)
        # Event-anchor lists (spec 2026-08-24). Delegated to derive_anchors'
        # OWN entry point, reading the omop/*.json just written above, rather
        # than calling the three anchor builders in sequence here.
        #
        # This file used to re-implement that sequence, and it drifted three
        # times: the builders gained a `win` argument (observation window),
        # obligation_point_anchors' inputs changed from bursts to exacerbations +
        # encounter anchors, and ocs_burst_anchors gained asthma attribution. Each
        # change left etl.py calling a signature that no longer existed, so the
        # full ETL raised TypeError on its first patient — undetected, because
        # nothing runs it in CI and the standalone derive_anchors.py (which every
        # local regeneration uses) was fine. One call site cannot drift from
        # itself.
        derive_for_patient(pdir)
        used = set(); doctypes = set()
        for r in G["notes"].get(pid, []):
            dt = str(r["note_date"])[:10]; dtp = slug(r["doc_type"]); doctypes.add(dtp)
            base = f"{dt}__{dtp}"; fn = base; k = 2
            while fn in used: fn = f"{base}_{k}"; k += 1
            used.add(fn)
            if r["note_text"]: open(os.path.join(pdir,"notes",f"{fn}.txt"),"w").write(str(r["note_text"]))
        json.dump({"patient_id":anon,"category":"asthma_adherence_real","demographics":{"age":age,"sex":sex},
                   "index_date":idx,"phi":True,"doc_types":sorted(doctypes),
                   "source":"OMOP ETL (scripts/asthma-omop-extract) — real de-identified EHR",
                   "note":"Real patient; PHI — gitignored. Chart filtered to date <= index_date."},
                  open(os.path.join(pdir,"meta.json"),"w"), indent=2)
        n += 1
    print(f"[etl] done — {n} patient corpora written under {a.out}/")

if __name__ == "__main__": main()
