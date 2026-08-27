#!/usr/bin/env python3
"""LCN outcome-date scanner — pure rules, no model calls. v0.7 (v0.6 + source-code decompensation channel).

v0.7 (XG-verify audit, 2026-08-26): decompensation condition codes are matched
on the SOURCE code as well as the concept name — the OMOP mapping hides the
semantics (K70.31 'alcoholic cirrhosis WITH ASCITES' -> concept 'Alcoholic
cirrhosis'; K72.90 -> 'Hepatic failure'), so name-only matching was blind to
them. OHE code trails and lactulose/rifaximin fills (drugs.json, present in
re-materialized packages) now feed the CTP encephalopathy component and a
non-blocking review warning. Blocking still belongs to agent tier grading.

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

v0.6 (from the pilot audit — 3 of 5 MET were lab-refutable false positives):
 - MELD-Na and the CTP LAB floor are SCANNER-COMPUTED from measurements.json
   at EVERY candidate date (labs valid 90d back; same-day duplicates -> median).
   A candidate is disqualified when computed MELD-Na >= 15 or when the three
   lab components ALONE force CTP >= 7 (class B even with no ascites/OHE).
   The agent's reference-anchored meld_na_ge_15 / ctp_class answers remain as
   a note-based fallback at t == reference only.
 - lab-panel dates join the candidate set (so recovery after a decompensated
   spell is representable).
 - advisory (non-blocking): count of structured ascites condition codes in the
   365d window before the outcome is reported as a review warning.

Known limitations (documented): one dated event per decompensation type;
op 4 (distinct studies) flagged by the agent, not enforced numerically here.

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

LAB_DEFS = {
    # analyte -> (must-contain terms (any), must-not-contain terms, plausible range)
    "bili":    (("bilirubin",),   ("direct", "urine", "neonat", "indirect"), (0.05, 80)),
    "albumin": (("albumin",),     ("urine", "csf", "microalbumin", "prealbumin", "/creatinine", "ratio"), (0.5, 6.5)),
    "inr":     (("inr", "international normalized"), ("urine",), (0.5, 20)),
    "creat":   (("creatinine",),  ("clearance", "cockcroft", "glomerular", "ratio", "urine"), (0.1, 25)),
    "sodium":  (("sodium",),      ("urine", "24 h", "24h", "sweat"), (100, 190)),
}

def lab_series(pid):
    """analyte -> sorted [(date, value)] from the package's rubric-filtered labs."""
    f = f"{PLAT}/corpus/patients/{pid}/omop/measurements.json"
    out = {k: [] for k in LAB_DEFS}
    if not os.path.exists(f): return out
    for r in json.load(open(f)):
        nm = (r.get("concept_name") or "").lower()
        d_ = pd(r.get("date"))
        try: v = float(r.get("value"))
        except (TypeError, ValueError): continue
        if not d_: continue
        for k, (need, ban, (lo, hi)) in LAB_DEFS.items():
            if not any(t in nm for t in need): continue
            if any(t in nm for t in ban): continue
            if k == "bili" and "total" not in nm: continue
            if k == "creat" and not ("blood" in nm or "serum" in nm or "plasma" in nm): continue
            if k == "sodium" and not ("blood" in nm or "serum" in nm or "plasma" in nm): continue
            if lo <= v <= hi: out[k].append((d_, v))
    return {k: sorted(vs) for k, vs in out.items()}

def _latest_within(series, t, days=90):
    """Median of the values on the most recent lab date in (t-days, t]."""
    vals = [(d_, v) for d_, v in series if t - timedelta(days=days) < d_ <= t]
    if not vals: return None
    dmax = max(d_ for d_, _ in vals)
    day = sorted(v for d_, v in vals if d_ == dmax)
    return day[len(day) // 2]

def meld_ctp_at(labs, t, asc_current=False, ohe_current=False):
    """(meld_na, ctp_floor, detail) at candidate date t; None where not computable.
    ctp_floor = bili+albumin+INR points + ascites component + OHE component.
    The ascites/OHE components default to 1 (absent) and rise to 2 (at least
    slight/grade I-II) when documented ascites / OHE is CURRENT at t (any
    evidence within the prior 90d — agent-dated event or structured ascites
    code); severity beyond 'slight' is never assumed, so this stays a FLOOR."""
    from math import log
    b = _latest_within(labs["bili"], t);    a = _latest_within(labs["albumin"], t)
    i = _latest_within(labs["inr"], t);     c = _latest_within(labs["creat"], t)
    na = _latest_within(labs["sodium"], t)
    meld_na = None
    if b is not None and i is not None and c is not None:
        cc = min(max(c, 1.0), 4.0)
        meld = 10 * (0.957 * log(max(cc, 1.0)) + 0.378 * log(max(b, 1.0))
                     + 1.120 * log(max(i, 1.0)) + 0.643)
        meld_na = meld
        if na is not None and meld > 11:
            nn = min(max(na, 125.0), 137.0)
            meld_na = meld + 1.32 * (137 - nn) - 0.033 * meld * (137 - nn)
        meld_na = round(meld_na, 1)
    ctp_floor = None
    if b is not None and a is not None and i is not None:
        pts = (1 if b < 2 else 2 if b <= 3 else 3) \
            + (1 if a > 3.5 else 2 if a >= 2.8 else 3) \
            + (1 if i < 1.7 else 2 if i <= 2.3 else 3)
        ctp_floor = pts + (2 if asc_current else 1) + (2 if ohe_current else 1)
    detail = f"bili={b} alb={a} inr={i} creat={c} na={na} -> MELD-Na={meld_na} CTP_lab_floor={ctp_floor}"
    return meld_na, ctp_floor, detail

def _code(sv):  # '1284^^K70.31^' -> 'K70.31'
    import re as _re
    return next((p for p in str(sv or "").split("^") if _re.match(r"^[A-Z]\d", p)), "")

def decomp_code_dates(pid):
    """kind -> sorted unique dates, matched on SOURCE code + concept name."""
    f = f"{PLAT}/corpus/patients/{pid}/omop/conditions.json"
    out = {"ascites": [], "ohe": [], "vbleed": []}
    if not os.path.exists(f): return out
    for r in json.load(open(f)):
        code = _code(r.get("source_value")); nm = (r.get("concept_name") or "").lower()
        d_ = pd(r.get("date") or r.get("start_date"))
        if not d_: continue
        if code.startswith(("R18", "K70.31", "K70.11", "K71.51")) or "ascites" in nm:
            out["ascites"].append(d_)
        if code.startswith(("K72.9", "K72.0", "K72.1")) or "encephalopath" in nm or "hepatic failure" in nm:
            out["ohe"].append(d_)
        if code.startswith(("I85.01", "I85.11")) or ("varice" in nm and ("bleed" in nm or "hemorrh" in nm)):
            out["vbleed"].append(d_)
    return {k: sorted(set(v)) for k, v in out.items()}

def ohe_drug_dates(pid):
    """{'lactulose': dates, 'rifaximin': dates} from drugs.json (absent in old packages)."""
    f = f"{PLAT}/corpus/patients/{pid}/omop/drugs.json"
    out = {"lactulose": [], "rifaximin": []}
    if not os.path.exists(f): return out
    for r in json.load(open(f)):
        blob = ((r.get("concept_name") or "") + " " + (r.get("source_value") or "")).lower()
        d_ = pd(r.get("start_date"))
        if not d_: continue
        for g in out:
            if g in blob: out[g].append(d_)
    return {g: sorted(set(v)) for g, v in out.items()}

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
    labs = lab_series(pid)
    dc = decomp_code_dates(pid)
    asc_codes = dc["ascites"]
    ohe_codes = dc["ohe"]
    _fills = ohe_drug_dates(pid)
    ohe_drugs = sorted(set(_fills["lactulose"] + _fills["rifaximin"]))
    rif_fills = _fills["rifaximin"]

    tmin = max([step1_first] + ([start] if start else []))
    cands = {tmin, ref}
    for e in decomp: cands.add(e + timedelta(days=W_DECOMP + 1))
    if encs: cands |= {d for d in encs if d >= tmin}
    # lab-panel dates are candidates too — a patient disqualified by severity
    # at tmin may qualify later once labs recover (v0.6)
    for series in labs.values():
        cands |= {d for d, _ in series if d >= tmin}
    cands = sorted(t for t in cands if tmin <= t <= ref)

    birth_year = (meta_index.year - age_at_meta_index) if age_at_meta_index is not None else None
    sev_blocked = None
    for t in cands:
        if birth_year and (t.year - birth_year) < 18: continue
        if any(e <= t <= e + timedelta(days=W_DECOMP) for e in decomp): continue
        if shunt and t >= shunt: continue
        if encs is not None and not any(t - timedelta(days=W_DECOMP) < d <= t for d in encs): continue
        # v0.6 scanner-computed severity at EVERY candidate date (pure-lab per
        # protocol Step 2(ii)/(iii)); CTP uses the lab-only FLOOR so a patient
        # is disqualified only when labs alone already force class B
        recent = lambda d_: d_ is not None and t - timedelta(days=90) < d_ <= t
        asc_now = recent(ev["ascites_date"]) or any(recent(d_) for d_ in asc_codes)
        ohe_now = (recent(ev["ohe_date"]) or any(recent(d_) for d_ in ohe_codes)
                   or any(recent(d_) for d_ in ohe_drugs))
        # v0.7.1 code-corroborated OHE trail (XG-verify patient 5046a3, agent
        # repeatedly index-anchored ohe_date across 3 runs): an OHE/hepatic-
        # failure code AND >=2 lactulose/rifaximin fills inside the 365d window
        # = a highly_likely-equivalent OHE event -> blocks (op-6 blocks OHE at
        # definite OR highly_likely). Ascites stays warning-only: its blocking
        # bar is definite, which codes+drugs cannot establish.
        # PENDING Tapper/Hao confirmation of the codes+therapy equivalence.
        w365 = lambda ds: [d for d in ds if t - timedelta(days=W_DECOMP) < d <= t]
        # blocks when (a) an OHE code is corroborated by >=2 HE-drug fills, or
        # (b) >=2 rifaximin fills alone — in a cirrhosis cohort rifaximin
        # maintenance IS ongoing-HE therapy, and code gaps between visits
        # otherwise open false 'compensated' windows mid-treatment.
        if (w365(ohe_codes) and len(w365(ohe_drugs)) >= 2) or len(w365(rif_fills)) >= 2:
            sev_blocked = (f"{t}: OHE therapy trail — {len(w365(ohe_codes))} code(s), "
                           f"{len(w365(rif_fills))} rifaximin + "
                           f"{len(w365(_fills['lactulose']))} lactulose fills in-window")
            continue
        mna, ctp_floor, sev_detail = meld_ctp_at(labs, t, asc_now, ohe_now)
        if (mna is not None and mna >= 15) or (ctp_floor is not None and ctp_floor >= 7):
            sev_blocked = f"{t}: {sev_detail}"
            continue
        if t == ref:  # note-documented current-severity fallback (agent answers)
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
        out["severity_at_outcome"] = sev_detail
        in_w = lambda ds: [d for d in ds if t - timedelta(days=W_DECOMP) < d <= t]
        asc = in_w(asc_codes)
        if asc:
            out["warning_ascites_codes_365d"] = (
                f"{len(asc)} structured ascites condition code(s) in the 365d window "
                f"(latest {max(asc)}) — non-blocking (tier grading owns blocking); REVIEW")
        ohe_w, drug_w = in_w(ohe_codes), in_w(ohe_drugs)
        if ohe_w or drug_w:
            out["warning_ohe_signals_365d"] = (
                f"{len(ohe_w)} OHE/hepatic-failure code(s)"
                + (f" + {len(drug_w)} lactulose/rifaximin fill(s)" if drug_w else "")
                + f" in the 365d window (latest {max(ohe_w + drug_w)}) — non-blocking; REVIEW")
        vb = in_w(dc["vbleed"])
        if vb:
            out["warning_vbleed_codes_365d"] = (
                f"{len(vb)} variceal-bleeding code(s) in the 365d window "
                f"(latest {max(vb)}) — non-blocking; REVIEW")
        return out
    nm = {"patient": pid, "outcome_date": None,
          "scan_start": str(start) if start else "(none — legacy)", "reference": str(ref),
          "step1_first": str(step1_first), "step1_basis": s1_basis,
          "why": "no candidate date in [scan_start, reference] satisfies Step 2"}
    if sev_blocked: nm["last_severity_block"] = sev_blocked
    return nm

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
