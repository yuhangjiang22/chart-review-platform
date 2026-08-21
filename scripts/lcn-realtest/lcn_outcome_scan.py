#!/usr/bin/env python3
"""LCN outcome-date scanner — pure rules, no model calls. v0.3 (Compensated_CP_v2).

Takes a v0.2+ agent draft (evidence-date fields) and computes the FIRST date on
which Step 1 AND Step 2 are satisfied ("The first date on which both Step 1 and
Step 2 are satisfied will define the first compensated cirrhosis outcome").

v0.3 semantics, per Compensated_CP_v2's operational definitions:
 - op 5  STEP 1 IS PERMANENT once met: the scanner finds the earliest date the
   cirrhosis definition holds (biopsy-recent alone, or >=2 criteria concurrently
   active) and treats Step 1 as true from that date onward — criteria windows
   lapsing no longer un-establishes cirrhosis (v0.2 required concurrent windows
   at the candidate date).
 - op 6  BLOCKING TIERS per complication: ascites blocks only at `definite`;
   overt HE at `definite` or `highly_likely`; variceal/PHG bleeding only at
   `definite`; `probable` NEVER blocks. (v0.2 blocked on any tier != none.)
   A dated event OUTSIDE the graded 365d-before-index window has no tier — it
   still blocks [e, e+365] conservatively.
 - op 6  ENCOUNTER REQUIREMENT: the 365-day no-decompensation window requires
   >=1 encounter — a patient simply not seen is not read as stable. Enforced
   from the patient package's omop/encounters.json; if that table is absent,
   the check is skipped and the result notes it.

Window constants (days): imaging/stiffness 365, varices 1095, biomarker 183,
biopsy recent-rule 1826 (sufficient alone; at >=1826 days the SAME biopsy
becomes criterion E), decompensation events disqualify [e, e+365].
Shunt disqualifies every date >= shunt_date (shunt_ever=yes with no date →
ALL dates conservatively disqualified).

Known pilot limitations (documented, not hidden):
 - only the MOST RECENT decompensation event per type is dated by the agent;
   earlier same-type events are invisible to the scan;
 - MELD-Na / CTP are assessed "current at index" only -> applied only when the
   candidate date IS the index date;
 - candidate dates are capped at the materialized index date (chart truncated);
 - op 4 (distinct studies) is flagged by the agent in crit_c rationale, not
   enforced numerically here.

Usage:
  python3 lcn_outcome_scan.py patient_real_lcn_xxx [more ids...]   # latest draft per patient
"""
import json, glob, os, sys
from datetime import date, timedelta

PLAT = "/Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform"
W_A, W_B, W_C, W_D = 365, 365, 1095, 183
W_BIOPSY = 1826           # <5y: sufficient alone; >=5y: criterion E
W_DECOMP = 365

# op 6: which extracted tier BLOCKS, per complication (probable never blocks)
BLOCKING_TIERS = {
    "ascites_date":        ("ascites_365d",        {"definite"}),
    "ohe_date":            ("ohe_365d",            {"definite", "highly_likely"}),
    "variceal_bleed_date": ("variceal_bleed_365d", {"definite"}),
    "phg_bleed_date":      ("phg_bleed_365d",      {"definite"}),
}

def pd(v):
    if not v or str(v).lower() in ("none", "null", ""): return None
    s = str(v)[:10]
    try: return date.fromisoformat(s)
    except ValueError: return None

def latest_draft(pid):
    cands = sorted(glob.glob(f"{PLAT}/var/runs/*/per_patient/{pid}/agents/agent_1.json"))
    for f in reversed(cands):
        d = json.load(open(f))
        fa = {a["field_id"]: a.get("answer") for a in d.get("field_assessments", [])}
        if "crit_a_date" in {a["field_id"] for a in d.get("field_assessments", [])}:  # v0.2+ draft
            return f, fa
    return None, None

def encounter_dates(pid):
    f = f"{PLAT}/corpus/patients/{pid}/omop/encounters.json"
    if not os.path.exists(f): return None
    out = []
    for r in json.load(open(f)):
        d_ = pd(r.get("start_date") or r.get("date"))
        if d_: out.append(d_)
    return sorted(out) if out else None

def scan(pid):
    f, fa = latest_draft(pid)
    if not fa:
        return {"patient": pid, "error": "no v0.2+ draft with date fields — rerun the agent on rubric v0.2+"}
    meta = json.load(open(f"{PLAT}/corpus/patients/{pid}/meta.json"))
    index = pd(meta["index_date"]); age_at_index = (meta.get("demographics") or {}).get("age")

    if fa.get("excl_cardiac_cirrhosis") == "yes" or fa.get("excl_fald") == "yes":
        return {"patient": pid, "outcome_date": None, "why": "Step-1 exclusion (cardiac cirrhosis / FALD)"}

    ev = {k: pd(fa.get(k)) for k in
          ["crit_a_date","crit_b_date","crit_c_date","crit_d_date","biopsy_cirrhosis_date",
           "ascites_date","ohe_date","variceal_bleed_date","phg_bleed_date","shunt_date"]}
    ivals = {}
    for key, dk, w in [("A","crit_a_date",W_A),("B","crit_b_date",W_B),("C","crit_c_date",W_C),("D","crit_d_date",W_D)]:
        if ev[dk]: ivals[key] = (ev[dk], ev[dk] + timedelta(days=w))
    bx = ev["biopsy_cirrhosis_date"]

    def step1_active(t):
        active = {k for k, (s, e) in ivals.items() if s <= t <= e}
        biopsy_recent = bx is not None and bx <= t and (t - bx).days < W_BIOPSY
        if bx is not None and bx <= t and (t - bx).days >= W_BIOPSY: active.add("E")
        return biopsy_recent or len(active) >= 2, active, biopsy_recent

    # ---- op 5: earliest date Step 1 holds; permanent thereafter ----
    s1_tests = sorted({iv[0] for iv in ivals.values()}
                      | ({bx, bx + timedelta(days=W_BIOPSY)} if bx else set()))
    step1_first = None; s1_basis = None
    for t in s1_tests:
        if t > index: break
        ok, active, biopsy_recent = step1_active(t)
        if ok:
            step1_first = t
            s1_basis = "recent biopsy alone" if biopsy_recent else f">=2 criteria active: {sorted(active)}"
            break
    if step1_first is None:
        return {"patient": pid, "outcome_date": None, "pilot_index": str(index),
                "why": "Step 1 never established within the truncated chart"}

    # ---- op 6: blocking decompensation events, per-complication tiers ----
    decomp = []
    soft_events = []   # dated but non-blocking under v0.3 (for reporting)
    for dk, (ek, tiers) in BLOCKING_TIERS.items():
        e = ev[dk]
        if not e: continue
        tier = fa.get(ek)
        in_window = (index - e).days <= W_DECOMP
        if in_window and tier not in tiers:
            soft_events.append(f"{dk.replace('_date','')}={tier}@{e}")
        else:
            decomp.append(e)   # blocking tier, or tier unknown outside the graded window
    shunt = ev["shunt_date"]
    if fa.get("shunt_ever") == "yes" and not shunt:
        return {"patient": pid, "outcome_date": None, "why": "shunt_ever=yes with unknown date — conservatively disqualified"}

    # ---- op 6: >=1 encounter required in the 365d window before the candidate ----
    encs = encounter_dates(pid)

    cands = {step1_first, index}
    for e in decomp: cands.add(e + timedelta(days=W_DECOMP + 1))
    if encs: cands |= {d for d in encs if d >= step1_first}
    cands = sorted(t for t in cands if step1_first <= t <= index)

    birth_year = (index.year - age_at_index) if age_at_index is not None else None
    for t in cands:
        if birth_year and (t.year - birth_year) < 18: continue
        if any(e <= t <= e + timedelta(days=W_DECOMP) for e in decomp): continue
        if shunt and t >= shunt: continue
        if encs is not None and not any(t - timedelta(days=W_DECOMP) < d <= t for d in encs): continue
        if t == index:  # index-only current-severity constraints
            if fa.get("meld_na_ge_15") == "yes": continue
            if fa.get("ctp_class") in ("B", "C"): continue
        out = {"patient": pid, "outcome_date": str(t), "pilot_index": str(index),
               "days_earlier_than_index": (index - t).days,
               "step1_first": str(step1_first), "step1_basis": s1_basis,
               "draft": f.split("/var/")[-1]}
        if soft_events: out["non_blocking_events_v03"] = soft_events
        if encs is None: out["note"] = "encounters table absent — op-6 encounter check skipped"
        return out
    return {"patient": pid, "outcome_date": None, "pilot_index": str(index),
            "step1_first": str(step1_first), "step1_basis": s1_basis,
            "why": "no candidate date satisfies Step 2 (with op-6 tiers + encounter check) within the truncated chart"}

if __name__ == "__main__":
    pids = sys.argv[1:] or sorted(os.path.basename(p) for p in glob.glob(f"{PLAT}/corpus/patients/patient_real_lcn_*"))
    for pid in pids:
        print(json.dumps(scan(pid), indent=1))
