#!/usr/bin/env python3
"""screen_v05.py — enrichment screen for the second annotation batch.

Scores every cohort member (same cohort.sql as etl.py, post-2020 window) on:
  * v0.5 eligibility  — >=2 asthma-related non-inpatient encounters in the
    12-month lookback, >=1 of them non-ED
  * controller fills in the 12-month window (structured med data present)
  * spirometry procedure in the 24-month window
  * pulmonology/allergy note titles in the window (specialty-managed signal)
  * exacerbation signal (asthma ED visit or OCS fill in window)
  * note volume in the window
then proposes a stratified 30-patient draw for the documentation-rich batch,
excluding already-materialized patients (same salt/prefix hash as etl.py).

Prints ONLY counts/aggregates; the candidate person_id list is written to
var/asthma-v05-screen.json (gitignored).

Usage (from chart-review-platform root):
  python3 scripts/asthma-realtest/screen_v05.py \
      --rdrp ../RDRP-6745 --notes "../RDRP-6745 Notes/r6745 Notes"
"""
import argparse, hashlib, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
# etl.py lives with the rest of the extraction path, not here: this script is an
# IU-specific one-off (it excludes already-materialized patients by OUR salt), so
# it was moved out of the site-facing folder and its `sys.path.insert(0, HERE)`
# stopped finding etl. A site does not need this file — SITE-GUIDE step 3's
# stratification is done with `etl.py --cohort-csv`.
sys.path.insert(0, os.path.join(HERE, "..", "asthma", "omop-extract"))
import etl  # reuse adapter/render/load

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rdrp", required=True); ap.add_argument("--notes", required=True)
    ap.add_argument("--salt", default=os.environ.get("ETL_SALT", "rdrp6745"))
    ap.add_argument("--prefix", default="patient_real_asthma_")
    ap.add_argument("--corpus", default="corpus/patients")
    ap.add_argument("--out", default="var/asthma-v05-screen.json")
    a = ap.parse_args()

    import duckdb
    con = duckdb.connect()
    etl.setup_adapter(con, os.path.join(HERE, "adapter_rdrp.sql"), a.rdrp, a.notes)
    coh = etl.render_duckdb(etl.load("cohort.sql")).strip().rstrip(";")
    con.execute(f"CREATE TABLE cohort AS SELECT * FROM ({coh}) t")
    n_coh = con.execute("SELECT count(*) FROM cohort").fetchone()[0]
    print(f"[screen] cohort (post-2020 index): {n_coh}")

    con.execute("""CREATE TABLE asthma_visit AS
      SELECT DISTINCT co.visit_occurrence_id FROM condition_occurrence co
      JOIN concept_ancestor ca ON ca.descendant_concept_id = co.condition_concept_id
      WHERE ca.ancestor_concept_id = 317009 AND co.visit_occurrence_id IS NOT NULL""")

    con.execute("""CREATE TABLE sig_enc AS
      SELECT c.person_id,
        count(*) FILTER (WHERE av.visit_occurrence_id IS NOT NULL
                         AND v.visit_concept_id <> 9201)               AS asthma_enc,
        count(*) FILTER (WHERE av.visit_occurrence_id IS NOT NULL
                         AND v.visit_concept_id NOT IN (9201, 9203))   AS asthma_outpt,
        count(*) FILTER (WHERE av.visit_occurrence_id IS NOT NULL
                         AND v.visit_concept_id = 9203)                AS asthma_ed
      FROM cohort c
      JOIN visit_occurrence v ON v.person_id = c.person_id
        AND v.visit_start_date > c.index_date - INTERVAL 12 MONTH
        AND v.visit_start_date <= c.index_date
      LEFT JOIN asthma_visit av ON av.visit_occurrence_id = v.visit_occurrence_id
      GROUP BY c.person_id""")

    con.execute("""CREATE TABLE sig_drug AS
      SELECT c.person_id,
        count(*) FILTER (WHERE m.is_controller)          AS controller_fills,
        count(*) FILTER (WHERE m.drug_class = 'OCS')     AS ocs_fills,
        count(*) FILTER (WHERE m.drug_class = 'SABA')    AS saba_fills
      FROM cohort c
      JOIN drug_exposure de ON de.person_id = c.person_id
        AND de.drug_exposure_start_date > c.index_date - INTERVAL 12 MONTH
        AND de.drug_exposure_start_date <= c.index_date
      JOIN concept_ancestor ca ON ca.descendant_concept_id = de.drug_concept_id
      JOIN drug_class_map m ON m.ingredient_concept_id = ca.ancestor_concept_id
      GROUP BY c.person_id""")

    con.execute("""CREATE TABLE sig_spiro AS
      SELECT c.person_id, count(*) AS spiro
      FROM cohort c
      JOIN procedure_occurrence po ON po.person_id = c.person_id
        AND po.procedure_date > c.index_date - INTERVAL 24 MONTH
        AND po.procedure_date <= c.index_date
      LEFT JOIN concept cc ON cc.concept_id = po.procedure_concept_id
      WHERE po.procedure_source_value IN ('94010','94060','94070')
         OR lower(coalesce(cc.concept_name,'')) LIKE '%spirometr%'
      GROUP BY c.person_id""")

    con.execute("""CREATE TABLE sig_note AS
      SELECT c.person_id, count(*) AS notes,
        count(*) FILTER (WHERE lower(coalesce(n.doc_type,'')) LIKE '%pulm%'
                          OR lower(coalesce(n.doc_type,'')) LIKE '%allerg%') AS spec_notes
      FROM cohort c
      JOIN note n ON n.person_id = c.person_id
        AND n.note_date > c.index_date - INTERVAL 12 MONTH
        AND n.note_date <= c.index_date
      GROUP BY c.person_id""")

    rows = con.execute("""
      SELECT c.person_id,
        coalesce(e.asthma_enc,0), coalesce(e.asthma_outpt,0), coalesce(e.asthma_ed,0),
        coalesce(d.controller_fills,0), coalesce(d.ocs_fills,0), coalesce(d.saba_fills,0),
        coalesce(s.spiro,0), coalesce(nt.notes,0), coalesce(nt.spec_notes,0)
      FROM cohort c
      LEFT JOIN sig_enc  e  ON e.person_id  = c.person_id
      LEFT JOIN sig_drug d  ON d.person_id  = c.person_id
      LEFT JOIN sig_spiro s ON s.person_id  = c.person_id
      LEFT JOIN sig_note nt ON nt.person_id = c.person_id""").fetchall()

    existing = {p for p in os.listdir(a.corpus) if p.startswith(a.prefix)} if os.path.isdir(a.corpus) else set()
    def anon(pid): return a.prefix + hashlib.sha256((a.salt + str(pid)).encode()).hexdigest()[:12]

    cands = []
    n_elig = n_alr = 0
    for pid, enc, outpt, ed, ctrl, ocs, saba, spiro, notes, spec in rows:
        eligible = enc >= 2 and outpt >= 1
        if not eligible: continue
        n_elig += 1
        if anon(pid) in existing: n_alr += 1; continue
        cands.append(dict(person_id=str(pid), asthma_enc=enc, asthma_outpt=outpt, asthma_ed=ed,
                          controller_fills=ctrl, ocs_fills=ocs, saba_fills=saba,
                          spiro=spiro, notes=notes, spec_notes=spec))

    print(f"[screen] v0.5-eligible: {n_elig}  (already materialized: {n_alr})")
    def n(f): return sum(1 for c in cands if f(c))
    print(f"[screen] candidates remaining: {len(cands)}")
    print(f"  controller fills >0 (structured med data):  {n(lambda c: c['controller_fills']>0)}")
    print(f"  spirometry in 24mo:                         {n(lambda c: c['spiro']>0)}")
    print(f"  pulm/allergy notes in window:               {n(lambda c: c['spec_notes']>0)}")
    print(f"  exacerbation signal (asthma ED or OCS):     {n(lambda c: c['asthma_ed']>0 or c['ocs_fills']>0)}")
    print(f"  notes >=30 in window:                       {n(lambda c: c['notes']>=30)}")
    print(f"  controller + specialty (hard-question rich): {n(lambda c: c['controller_fills']>0 and (c['spec_notes']>0 or c['spiro']>0))}")

    # stratified draw: deterministic (sorted by notes desc then person_id)
    def take(pool, k, taken):
        out = []
        for c in sorted(pool, key=lambda x: (-x["notes"], x["person_id"])):
            if c["person_id"] in taken: continue
            out.append(c); taken.add(c["person_id"])
            if len(out) == k: break
        return out
    taken = set()
    s1 = take([c for c in cands if c["controller_fills"]>0 and (c["spec_notes"]>0 or c["spiro"]>0)], 12, taken)
    s2 = take([c for c in cands if c["controller_fills"]>0], 10, taken)
    s3 = take([c for c in cands if c["asthma_ed"]>0 or c["ocs_fills"]>0], 8, taken)
    draw = {"S1_specialty_or_spiro_with_controller": s1,
            "S2_controller_documented": s2,
            "S3_exacerbation_signal": s3}
    print(f"[screen] proposed draw: S1={len(s1)} S2={len(s2)} S3={len(s3)}  total={len(s1)+len(s2)+len(s3)}")
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump({"eligible": n_elig, "already_materialized": n_alr, "draw": draw,
               "all_candidates": cands}, open(a.out, "w"), indent=1)
    print(f"[screen] candidate list -> {a.out} (gitignored; ids only, no PHI text)")

if __name__ == "__main__":
    main()
