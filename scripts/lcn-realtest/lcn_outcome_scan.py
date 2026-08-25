#!/usr/bin/env python3
"""LCN outcome-date scanner — pure rules, no model calls. v0.5 (forward scan + scanner-computed platelet arm).

Computes the FIRST date on which Step 1 AND Step 2 hold ("The first date on
which both Step 1 and Step 2 are satisfied will define the first compensated
cirrhosis outcome"), scanning FORWARD from the patient's index date.

DATE SEMANTICS (v0.4, AUD-cohort design per Compensated_CP_v2):
 - index_date   = scan START (first documented AUD; from meta in AUD-cohort
   materializations, or from --aud-cohort CSV for legacy pilot materializations).
 - reference_date = scan END and the date "current" assessments (MELD-Na, CTP,
   decompensation tier grading window) refer to — the last data activity in
   AUD-cohort materializations; equals the old index for legacy ones.
 - candidates lie in [max(index, step1_first, 18th birthday), reference_date].
Legacy fallback: with no AUD index available, scans [step1_first, reference]
exactly like v0.3.

v0.3 semantics retained (Compensated_CP_v2 ops):
 - op 5 Step 1 PERMANENT once met (earliest establishment date; persists).
 - op 6 blocking tiers: ascites/variceal/PHG definite only; OHE definite or
   highly_likely; probable never blocks; out-of-grading-window dated events
   block conservatively.
 - op 6 the 365-day no-decompensation window requires >=1 encounter.

Known limitations (documented): one dated event per decompensation type;
MELD/CTP applied only at reference_date; op 4 (distinct studies) flagged by
the agent, not enforced numerically here.

Usage:
  python3 lcn_outcome_scan.py [--aud-cohort ../docs/lcn_clean_cohort_local.csv]
      [--salt rdrp6263] [patient_real_lcn_xxx ...]
"""
import argparse, csv, glob, hashlib, json, os, sys
from datetime import date, timedelta

PLAT = "/Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform"
W_A, W_B, W_C, W_D = 365, 365, 1095, 183
W_BIOPSY = 1826
W_DECOMP = 365

BLOCKING_TIERS = {
    "ascites_date":        ("ascites_365d",        {"definite"}),
    "ohe_date":            ("ohe_365d",            {"definite", "highly_likely"}),
    "variceal_bleed_date": ("variceal_bleed_365d", {"definite"}),
    "phg_bleed_date":      ("phg_bleed_365d",      {"definite"}),
}

def pd(v):
    if not v or str(v).lower() in ("none", "null", "", "no_info", "unknown"): return None
    try: return date.fromisoformat(str(v)[:10])
    except ValueError: return None

def latest_draft(pid):
    cands = sorted(glob.glob(f"{PLAT}/var/runs/*/per_patient/{pid}/agents/agent_1.json"))
    for f in reversed(cands):
        d = json.load(open(f))
        fas = d.get("field_assessments", [])
        fa = {a["field_id"]: a.get("answer") for a in fas}
        # require a COMPLETE draft — a run that died mid-patient leaves a
        # partial draft whose missing decomp/exclusion fields would be read
        # as benign Nones (false MET risk)
        if "crit_a_date" in fa and len(fas) >= 31:
            return f, fa
    return None, None

def platelet_dates(pid):
    """All qualifying platelet(<150) dates from the package — crit D's platelet
    arm is fully structured, so the SCANNER computes it (union of windows over
    ALL qualifying rows); the agent's crit_d_date still contributes (e.g. a
    documented FIB-4)."""
    f = f"{PLAT}/corpus/patients/{pid}/omop/measurements.json"
    if not os.path.exists(f): return []
    out = []
    for r in json.load(open(f)):
        nm = (r.get("concept_name") or "").lower()
        if "platelet" not in nm or "mean" in nm or "distribution" in nm or "plasma" in nm: continue
        v = r.get("value")
        try: v = float(v)
        except (TypeError, ValueError): continue
        if 1 < v < 150:
            d_ = pd(r.get("date"))
            if d_: out.append(d_)
    return sorted(set(out))

def encounter_dates(pid):
    f = f"{PLAT}/corpus/patients/{pid}/omop/encounters.json"
    if not os.path.exists(f): return None
    out = []
    for r in json.load(open(f)):
        d_ = pd(r.get("start_date") or r.get("date"))
        if d_: out.append(d_)
    return sorted(out) if out else None

def scan(pid, aud_map=None):
    f, fa = latest_draft(pid)
    if not fa:
        return {"patient": pid, "error": "no v0.2+ draft with date fields — rerun the agent on rubric v0.2+"}
    meta = json.load(open(f"{PLAT}/corpus/patients/{pid}/meta.json"))
    meta_index = pd(meta["index_date"])
    ref = pd(meta.get("reference_date")) or meta_index
    if meta.get("reference_date"):
        start = meta_index                       # AUD-cohort materialization
    elif aud_map and pid in aud_map:
        start = aud_map[pid]                     # legacy chart + external AUD index
    else:
        start = None                             # legacy v0.3 behavior
    age_at_meta_index = (meta.get("demographics") or {}).get("age")

    if fa.get("excl_cardiac_cirrhosis") == "yes" or fa.get("excl_fald") == "yes":
        return {"patient": pid, "outcome_date": None, "why": "Step-1 exclusion (cardiac cirrhosis / FALD)"}

    ev = {k: pd(fa.get(k)) for k in
          ["crit_a_date","crit_b_date","crit_c_date","crit_d_date","biopsy_cirrhosis_date",
           "ascites_date","ohe_date","variceal_bleed_date","phg_bleed_date","shunt_date"]}
    ivals = {}   # key -> list of (start, end) activation intervals
    for key, dk, w in [("A","crit_a_date",W_A),("B","crit_b_date",W_B),("C","crit_c_date",W_C),("D","crit_d_date",W_D)]:
        if ev[dk]: ivals.setdefault(key, []).append((ev[dk], ev[dk] + timedelta(days=w)))
    # v0.5: crit D's platelet arm is scanner-computed over ALL qualifying rows
    for d_ in platelet_dates(pid):
        ivals.setdefault("D", []).append((d_, d_ + timedelta(days=W_D)))
    bx = ev["biopsy_cirrhosis_date"]

    def step1_active(t):
        active = {k for k, spans in ivals.items() if any(s <= t <= e for s, e in spans)}
        biopsy_recent = bx is not None and bx <= t and (t - bx).days < W_BIOPSY
        if bx is not None and bx <= t and (t - bx).days >= W_BIOPSY: active.add("E")
        return biopsy_recent or len(active) >= 2, active, biopsy_recent

    # op 5: earliest date Step 1 holds; permanent thereafter
    s1_tests = sorted({s for spans in ivals.values() for s, _ in spans}
                      | ({bx, bx + timedelta(days=W_BIOPSY)} if bx else set()))
    step1_first = None; s1_basis = None
    for t in s1_tests:
        if t > ref: break
        ok, active, biopsy_recent = step1_active(t)
        if ok:
            step1_first = t
            s1_basis = "recent biopsy alone" if biopsy_recent else f">=2 criteria active: {sorted(active)}"
            break
    if step1_first is None:
        return {"patient": pid, "outcome_date": None, "reference": str(ref),
                "scan_start": str(start) if start else "(none — legacy)",
                "why": "Step 1 never established within the chart"}

    # op 6: blocking decompensation events (tier grading is relative to ref)
    decomp, soft_events = [], []
    for dk, (ek, tiers) in BLOCKING_TIERS.items():
        e = ev[dk]
        if not e: continue
        tier = fa.get(ek)
        in_window = (ref - e).days <= W_DECOMP
        if in_window and tier not in tiers:
            soft_events.append(f"{dk.replace('_date','')}={tier}@{e}")
        else:
            decomp.append(e)
    shunt = ev["shunt_date"]
    if fa.get("shunt_ever") == "yes" and not shunt:
        return {"patient": pid, "outcome_date": None, "why": "shunt_ever=yes with unknown date — conservatively disqualified"}

    encs = encounter_dates(pid)

    tmin = max([step1_first] + ([start] if start else []))
    cands = {tmin, ref}
    for e in decomp: cands.add(e + timedelta(days=W_DECOMP + 1))
    if encs: cands |= {d for d in encs if d >= tmin}
    cands = sorted(t for t in cands if tmin <= t <= ref)

    birth_year = (meta_index.year - age_at_meta_index) if age_at_meta_index is not None else None
    for t in cands:
        if birth_year and (t.year - birth_year) < 18: continue
        if any(e <= t <= e + timedelta(days=W_DECOMP) for e in decomp): continue
        if shunt and t >= shunt: continue
        if encs is not None and not any(t - timedelta(days=W_DECOMP) < d <= t for d in encs): continue
        if t == ref:  # reference-date-only current-severity constraints
            if fa.get("meld_na_ge_15") == "yes": continue
            if fa.get("ctp_class") in ("B", "C"): continue
        out = {"patient": pid, "outcome_date": str(t),
               "scan_start": str(start) if start else "(none — legacy)",
               "reference": str(ref),
               "days_after_index": (t - start).days if start else None,
               "step1_first": str(step1_first), "step1_basis": s1_basis,
               "draft": f.split("/var/")[-1]}
        if soft_events: out["non_blocking_events"] = soft_events
        if encs is None: out["note"] = "encounters table absent — op-6 encounter check skipped"
        return out
    return {"patient": pid, "outcome_date": None,
            "scan_start": str(start) if start else "(none — legacy)", "reference": str(ref),
            "step1_first": str(step1_first), "step1_basis": s1_basis,
            "why": "no candidate date in [scan_start, reference] satisfies Step 2"}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pids", nargs="*")
    ap.add_argument("--aud-cohort", help="clean-cohort CSV; maps AUD index onto legacy materializations")
    ap.add_argument("--salt", default=os.environ.get("ETL_SALT", "rdrp6263"))
    a = ap.parse_args()
    aud_map = None
    if a.aud_cohort:
        aud_map = {}
        for r in csv.DictReader(open(a.aud_cohort)):
            anon = "patient_real_lcn_" + hashlib.sha256((a.salt + r["person_id"]).encode()).hexdigest()[:12]
            aud_map[anon] = pd(r["index_date"])
    pids = a.pids or sorted(os.path.basename(p) for p in glob.glob(f"{PLAT}/corpus/patients/patient_real_lcn_*"))
    for pid in pids:
        print(json.dumps(scan(pid, aud_map), indent=1))

if __name__ == "__main__":
    main()
