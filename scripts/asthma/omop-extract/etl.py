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
  python3 scripts/asthma/omop-extract/etl.py --check \
      --rdrp /path/to/RDRP-6745 --notes "/path/to/RDRP-6745 Notes/r6745 Notes"
  python3 scripts/asthma/omop-extract/etl.py \
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

# COHORT PARAMETERS. cohort.sql is byte-identical at every site — who is in the
# denominator cannot be a local decision — but the knobs its header documents ARE
# the site's to set, and every one of them used to be hardcoded in the substitution
# below. The guide told sites to set @min_notes_12mo and not to edit cohort.sql,
# which left no way to do either: the only route was to edit this file. Defaults
# match cohort.sql's own documented defaults, so an unflagged run is unchanged.
PARAMS = {
    "min_age": "2",
    "max_age": "17",
    "min_asthma_encounters": "2",
    "min_prior_observation_days": "365",
    # 0 = no note floor, matching cohort.sql's default. The local corpus is the
    # place to see the n_notes_12mo distribution before filtering on it.
    "min_notes_12mo": "0",
}
# Schema qualifier for a real warehouse: "" leaves @cdm_database_schema.person as
# `person`, which is what the adapter views provide. --cdm-schema omop_cdm makes it
# `omop_cdm.person`. Was a parameter of render_duckdb that no caller ever passed,
# so the README's "a standard warehouse points @cdm_database_schema at its CDM
# instead" had no code path.
SCHEMA_PREFIX = ""

def render_duckdb(sql, schema_prefix=None):
    """Stand-in for OHDSI SqlRender: substitute @params + translate the OHDSI
       functions we use to DuckDB. A real site uses SqlRender.translate() instead."""
    s = strip_comments(sql)
    s = s.replace("@cdm_database_schema.",
                  SCHEMA_PREFIX if schema_prefix is None else schema_prefix)
    s = s.replace("@cohort_table", "cohort").replace("@drug_class_table", "drug_class_map")
    # Longest name first: @min_notes_12mo must not be reached by a shorter key
    # that happens to be its prefix if one is ever added.
    for k in sorted(PARAMS, key=len, reverse=True):
        s = s.replace(f"@{k}", PARAMS[k])
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

# The OMOP views cohort.sql + extracts.sql read. A site's adapter must provide
# every one; `observation` is deliberately absent (nothing reads it), which the
# adapter contract table in SITE-GUIDE.md states.
REQUIRED_VIEWS = [
    "person", "visit_occurrence", "condition_occurrence", "drug_exposure",
    "measurement", "procedure_occurrence", "observation_period", "note", "concept",
]

def setup_adapter(con, adapter_path, rdrp, notes):
    """Run the site's adapter, then build the RxNorm ingredient → drug-class map.

    Adapter errors are reported by NAME rather than as a DuckDB traceback. Writing
    the adapter is the one task every site does itself, first, and getting it
    wrong on the first try is the normal case — a raw CatalogException from three
    frames down does not say which view is missing or which statement failed.
    """
    adapter = open(adapter_path).read().replace("{RD}", rdrp).replace("{RD_NOTES}", notes)
    for stmt in [x.strip() for x in strip_comments(adapter).split(";") if x.strip()]:
        try:
            con.execute(stmt)
        except Exception as e:
            first = stmt.split("\n", 1)[0][:90]
            sys.exit(f"[etl] adapter {os.path.basename(adapter_path)} failed on:\n"
                     f"        {first}\n"
                     f"      {type(e).__name__}: {str(e).splitlines()[0][:160]}")
    missing = [v for v in REQUIRED_VIEWS
               if not con.execute("SELECT count(*) FROM duckdb_views() WHERE view_name=?"
                                  " UNION ALL SELECT count(*) FROM duckdb_tables()"
                                  " WHERE table_name=?", [v, v]).fetchall()[0][0]
               and not con.execute("SELECT count(*) FROM duckdb_tables() WHERE table_name=?",
                                   [v]).fetchone()[0]]
    if missing:
        sys.exit(f"[etl] adapter {os.path.basename(adapter_path)} defines no "
                 f"{'view' if len(missing) == 1 else 'views'} for: {', '.join(missing)}\n"
                 f"      cohort.sql and extracts.sql read all of "
                 f"{', '.join(REQUIRED_VIEWS)}. See the adapter contract table in "
                 f"scripts/asthma/SITE-GUIDE.md, and adapter_rdrp.sql for a worked "
                 f"example. (`observation` is not required — nothing reads it.)")
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
        # one-directional bias as a missing answer.
        #
        # THREE DIFFERENT DENOMINATORS GET QUOTED FOR days_supply, AND ONLY ONE
        # MATTERS. Measured on the origin site's extract:
        #   43.2%  of rows in the whole drug_exposure table  (what --check reports)
        #   15%    of all fills in the extracted corpus       (what this comment
        #                                                      used to claim)
        #   0%     of the 2,366 IN-WINDOW fills — 0/1000 ICS, 0/989 SABA, 0/248
        #          OCS, 0/111 LTRA, 0/13 LAMA, 0/5 biologic
        # The last one is the denominator PDC actually uses, so at this site
        # refill_pdc_12mo is emitted for NOBODY, and refill_pdc_partial — the
        # marker the conformance WARN points at as the mitigation — never fires
        # either. Not a floor and not a flag: silence. A rubric question that
        # depends on PDC has to be answered from the notes here, and a site whose
        # in-window rate is non-zero is the exception rather than the norm.
        with_ds = [f for f in inwin if f["days_supply"] is not None]
        cov = sum(f["days_supply"] for f in with_ds)
        if e["is_controller"] and cov > 0:
            # min(1.0, …) over a fixed 365: the denominator is the observation
            # year, not the treatment period, so a controller started mid-window
            # reads low. Harmless while no site emits days_supply in-window; it
            # will need the treatment period the first time one does.
            e["refill_pdc_12mo"] = round(min(1.0, cov/365.0), 2)
            if len(with_ds) < len(inwin):
                e["refill_pdc_partial"] = (
                    f"{len(inwin) - len(with_ds)} of {len(inwin)} in-window fills "
                    f"have no days_supply — this PDC is a floor, not a rate")
        elif e["is_controller"] and inwin:
            # Distinguish "no coverage documented" from "no fills": the first is a
            # data-availability fact, and without it an absent PDC reads as an
            # adherence finding.
            e["refill_pdc_unavailable"] = (
                f"none of the {len(inwin)} in-window fills carry days_supply, "
                f"so no PDC can be computed for this drug")
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
      # MEASURED OVER THE WHOLE TABLE, WHICH IS NOT THE DENOMINATOR PDC USES.
      # This counts every drug_exposure row; PDC uses the 12-month IN-WINDOW
      # fills, and the two can differ completely — at the origin site this
      # reports 43.2% while 0 of 2,366 in-window fills carry a days_supply, so
      # no PDC is emitted for anybody and refill_pdc_partial never fires. Read
      # this as "does the column exist at all", and read the per-drug
      # refill_pdc_unavailable marker for whether PDC was actually computable.
      # The SABA count is unaffected either way (it counts fills, not supply).
      "days_supply_pct":(0,50,"whole-table rate; check refill_pdc_unavailable for the in-window one"),
      "act_structured":(0,1,"0 → ACT is note-only here (like INPC)"),
      "drug_ingredient_rollup":(1,1,"drugs must roll up to RxNorm ingredients")}
    print("=== conformance (site readiness) ===")
    # SITE-GUIDE says these "must PASS", and the exit code has to be able to say
    # so: a site scripting `--check` in CI had nothing to gate on, because this
    # printed its verdict and returned 0 either way. A per-query ERROR counts as a
    # failure too — an absent table is the loudest possible readiness problem
    # (cohort.sql INNER JOINs observation_period, and a partner site does not
    # have it), and it used to print one line and pass.
    failures = []
    for name, q in named_blocks(load("conformance.sql")).items():
        try: v = con.execute(q).fetchone()[0]
        except Exception as e:
            print(f"  {name:24} {'ERROR':>10}   FAIL  ({str(e)[:40]}) — table missing?")
            failures.append(name)
            continue
        v = 0 if v is None else v
        fail, warn, note = THRESH.get(name, (0,0,""))
        status = "FAIL" if v < fail else ("WARN" if v < warn else "PASS")
        if status == "FAIL": failures.append(name)
        print(f"  {name:24} {str(round(v,1)):>10}   {status:4}  {note}")
    if failures:
        print(f"\n  FAILED: {', '.join(failures)} — do not extract until these pass.")
    return 1 if failures else 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rdrp", required=True); ap.add_argument("--notes", required=True)
    ap.add_argument("--out", default="corpus/patients"); ap.add_argument("--limit", type=int)
    ap.add_argument("--patients"); ap.add_argument("--salt", default=os.environ.get("ETL_SALT","rdrp6745"))
    ap.add_argument("--site", metavar="CODE",
                    help="your site code, e.g. wcm. Sets the patient-id prefix to "
                         "patient_real_asthma_<CODE>_ so ids are unique across "
                         "sites when results are pooled. --prefix overrides it.")
    ap.add_argument("--prefix", default=None,
                    help="patient-id prefix (default: patient_real_asthma_, or "
                         "patient_real_asthma_<site>_ when --site is given)")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--adapter", default=os.path.join(HERE,"adapter_rdrp.sql"))
    ap.add_argument("--study-start", default="2021-01-01", help="index_date >= this (post-2020 = 2020 NAEPP edition)")
    ap.add_argument("--study-end", default="2100-01-01", help="index_date <= this")
    # cohort.sql's own parameters. Its header explains the reasoning behind each;
    # these defaults are the ones it documents, so omitting them changes nothing.
    ap.add_argument("--cdm-schema", default="",
                    help="schema qualifying the OMOP tables, e.g. omop_cdm. "
                         "Empty (default) uses the adapter's unqualified views.")
    ap.add_argument("--min-age", type=int, default=2, help="age at index >= this")
    ap.add_argument("--max-age", type=int, default=17, help="age at index <= this")
    ap.add_argument("--min-asthma-encounters", type=int, default=2,
                    help="asthma-related non-inpatient encounters in the lookback")
    ap.add_argument("--min-prior-observation-days", type=int, default=365,
                    help="days of observation before index")
    ap.add_argument("--cohort-csv", metavar="PATH",
                    help="write the cohort table to PATH and stop, without "
                         "extracting any charts. This is how SITE-GUIDE step 3's "
                         "stratified selection is done. LOCAL ONLY: contains "
                         "person_id.")
    ap.add_argument("--min-notes-12mo", type=int, default=0,
                    help="notes in the lookback window. 0 = no floor. Raise it once "
                         "you can see your own n_notes_12mo distribution — a chart "
                         "with no notes cannot answer a note-based question, and it "
                         "reads as 'not documented' rather than 'not observed'.")
    a = ap.parse_args()
    if a.prefix is None:
        a.prefix = f"patient_real_asthma_{a.site}_" if a.site else "patient_real_asthma_"
    # THE SALT IS NOT A DEFAULT ANYONE ELSE SHOULD ACCEPT. The pseudonymous id is
    # sha256(salt + person_id), so two sites sharing a salt produce colliding ids
    # for different children, and results pooled across them are silently wrong.
    # The built-in value is the origin site's; it stays the default so IU's
    # existing corpora still reproduce, but it cannot pass unremarked.
    if a.salt == "rdrp6745":
        print("[etl] WARNING: using the built-in salt 'rdrp6745' (the origin "
              "site's). Set --salt or $ETL_SALT to a value chosen at YOUR site, "
              "or your patient ids will collide with another site's.",
              file=sys.stderr)
    global STUDY_START, STUDY_END, SCHEMA_PREFIX
    STUDY_START, STUDY_END = a.study_start, a.study_end
    # cohort.sql writes `@cdm_database_schema.person`, so the qualifier carries its
    # own trailing dot — a site passes the bare schema name and never has to know.
    SCHEMA_PREFIX = f"{a.cdm_schema}." if a.cdm_schema else ""
    PARAMS.update({
        "min_age": str(a.min_age), "max_age": str(a.max_age),
        "min_asthma_encounters": str(a.min_asthma_encounters),
        "min_prior_observation_days": str(a.min_prior_observation_days),
        "min_notes_12mo": str(a.min_notes_12mo),
    })
    con = duckdb.connect(); setup_adapter(con, a.adapter, a.rdrp, a.notes)
    if a.check: return conformance(con)

    # cohort → table (limit/patients filter here so extracts join only these)
    where = ""
    if a.patients: where = " WHERE person_id IN (" + ",".join(f"'{p}'" for p in a.patients.split(",")) + ")"
    lim = f" LIMIT {a.limit}" if a.limit else ""
    coh = render_duckdb(load("cohort.sql")).strip().rstrip(";")
    con.execute(f"CREATE TABLE cohort AS SELECT * FROM ({coh}) t{where}{lim}")

    # LIST THE COHORT WITHOUT EXTRACTING IT.
    #
    # SITE-GUIDE step 3 says to "select ~30 from the cohort table, balanced across
    # age bands and including patients with ED contact", then extract only those
    # with --patients. Every column that instruction names is right here — and
    # nothing exposed the table, so the step could not be followed: the cohort was
    # built in memory and immediately extracted. Two of its columns (n_ed_12mo and
    # age_band_plan, the study plan's own sampling bands) were not merely hidden
    # but unreachable, since the per-patient meta.json does not carry them.
    #
    # LOCAL ONLY: person_id is a direct identifier. This file is the input to your
    # own --patients selection and never leaves the site — the same rule as the
    # return package's crosswalk.
    if a.cohort_csv:
        con.execute(
            f"COPY (SELECT * FROM cohort ORDER BY person_id) "
            f"TO '{a.cohort_csv}' (HEADER, DELIMITER ',')")
        n = con.execute("SELECT count(*) FROM cohort").fetchone()[0]
        print(f"[etl] cohort: {n} patients -> {a.cohort_csv}")
        print("      LOCAL ONLY — contains person_id. Do not send this file.\n")
        for col in ("age_band_plan", "age_band_naepp"):
            rows = con.execute(
                f"SELECT {col}, count(*) FROM cohort GROUP BY 1 ORDER BY 1").fetchall()
            print(f"      {col:16} " + "  ".join(f"{k}={v}" for k, v in rows))
        for col, label in (("n_ed_12mo", "with >=1 ED visit"),
                           ("n_notes_12mo", "with >=5 notes")):
            thr = 1 if col == "n_ed_12mo" else 5
            v = con.execute(
                f"SELECT count(*) FROM cohort WHERE {col} >= {thr}").fetchone()[0]
            print(f"      {label:24} {v}/{n}")
        short = con.execute(
            "SELECT count(*) FROM cohort WHERE days_observed_before_index < 730").fetchone()[0]
        print(f"      {'< 730d prior observation':24} {short}/{n}"
              "   (censored on the spirometry rule)")
        return 0
    # OBSERVABILITY FIELDS carried through to meta.json. cohort.sql emits both
    # and NOTHING downstream could see them, because the ETL dropped them here —
    # so the mitigation cohort.sql documents ("exclude the short-lookback
    # patients from the spirometry rule at analysis time rather than from the
    # cohort") had nothing to work with. A patient with 365-729 days of prior
    # observation is fully observable for every question EXCEPT the 24-month
    # spirometry one, and judging that one anyway reports a DOCUMENTATION_GAP
    # that is an artifact of the extract window, not of care.
    cohort = con.execute(
        "SELECT person_id, CAST(index_date AS VARCHAR), age_at_index, "
        "days_observed_before_index, n_notes_12mo FROM cohort").fetchall()
    print(f"[etl] cohort rows to extract: {len(cohort)}")
    pmeta = {r[0]: {"idx": r[1][:10], "age": r[2],
                    "days_observed_before_index": r[3], "n_notes_12mo": r[4]} for r in cohort}
    short = [r for r in cohort if (r[3] or 0) < 730]
    print(f"[etl] prior observation: {len(short)}/{len(cohort)} patients have < 730 days "
          f"(the 24-month spirometry question cannot be fully observed for them)")
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
        # The exacerbation count is NOT computed here. It used to be, and this
        # file's version drifted from derive_anchors' in two ways that both
        # OVERCOUNT — and it is the version the rubric tells the agent to
        # "PREFER", so its number reached answers while the anchor list (which
        # obligation_points, and now the write-path floor, are built from) said
        # something else:
        #
        #   * it windowed FIRST and then applied the 14-day separation, so an
        #     exacerbation starting just before the window with a same-course
        #     fill just inside it counted as a new event. derive_anchors
        #     separates over the FULL history and restricts afterwards.
        #   * it counted every OCS fill, with no asthma attribution. A prednisone
        #     course for something else counted as an asthma exacerbation;
        #     derive_anchors only counts one within 7 days of an asthma encounter.
        #
        # Filled in below from derive_for_patient's own count, so the precomputed
        # row, the anchor list, and the obligation the rule reads are one number.
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
                         "value_as_number":None,"date":idx}]
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
        anchor_counts = derive_for_patient(pdir)
        # One number, one implementation: the precomputed row the rubric points
        # the agent at IS the anchor list it will be checked against.
        observations[0]["value_as_number"] = anchor_counts.get("exacerbations", 0)
        json.dump(observations, open(os.path.join(pdir,"omop","observations.json"),"w"),
                  indent=2, default=str)
        used = set(); doctypes = set()
        for r in G["notes"].get(pid, []):
            dt = str(r["note_date"])[:10]; dtp = slug(r["doc_type"]); doctypes.add(dtp)
            base = f"{dt}__{dtp}"; fn = base; k = 2
            while fn in used: fn = f"{base}_{k}"; k += 1
            used.add(fn)
            if r["note_text"]: open(os.path.join(pdir,"notes",f"{fn}.txt"),"w").write(str(r["note_text"]))
        json.dump({"patient_id":anon,"category":"asthma_adherence_real","demographics":{"age":age,"sex":sex},
                   "index_date":idx,"phi":True,"doc_types":sorted(doctypes),
                   # How much chart there was to read BEFORE the index date, and how
                   # many notes fell in the 12-month lookback. Both decide whether a
                   # "not documented" answer means absent-from-care or
                   # absent-from-the-extract; without them nothing downstream can
                   # tell those apart.
                   "days_observed_before_index": pmeta[pid].get("days_observed_before_index"),
                   "n_notes_12mo": pmeta[pid].get("n_notes_12mo"),
                   "source":"OMOP ETL (scripts/asthma/omop-extract) — real de-identified EHR",
                   "note":"Real patient; PHI — gitignored. Chart filtered to date <= index_date."},
                  open(os.path.join(pdir,"meta.json"),"w"), indent=2)
        n += 1
    print(f"[etl] done — {n} patient corpora written under {a.out}/")

if __name__ == "__main__": sys.exit(main() or 0)
