#!/usr/bin/env python3
"""Post-run lint for AACV drafts. PRINTS NO PATIENT DATA — labels, booleans,
counts and coordinates only. Usage: python3 lint_drafts.py <run_id>"""
import json,glob,os,re,sys
from collections import Counter
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),"..",".."))
run=sys.argv[1]
# accepts either a run_id (var/runs/<id>/per_patient/<pid>/agent_draft.json)
# or "grouped" for the merged drafts (var/aacv-grouped/<pid>/merged_draft.json)
GROUPED = run == "grouped"
base=os.path.join(ROOT,"var","aacv-grouped") if GROUPED else os.path.join(ROOT,"var","runs",run,"per_patient")
CORP=os.path.join(ROOT,"corpus","patients")
QUAL=re.compile(r"serious|unstable|clinically significant|significant|severe|anaphyla|life[- ]threatening|threat to life|decompensat|end[- ]stage|uncontrolled|exacerbat|acute|sepsis|septic|metastat|malignan|hospitali[sz]|admitted|ICU|intensive care|emergen|unstable|critical|chemotherap|dialysis|transplant|intubat|failure",re.I)
NKDA=re.compile(r"NKDA|no known (drug |medication )?allerg|denies .{0,25}allerg|no (drug |medication )?allergies|allergies:?\s*none",re.I)
UNDEF_MET_ATOMS={"aacv_exc_018_a2","aacv_exc_018_a3","aacv_exc_027_a1","aacv_exc_027_a2","aacv_exc_027_a3"}
ALLERGY={"aacv_exc_026_a1","aacv_exc_026_a2","aacv_exc_026_a3","aacv_exc_027_a1","aacv_exc_027_a2","aacv_exc_033_a1"}
EXPECT_UNKNOWN={"aacv_exc_018_a1","aacv_exc_025_a3","aacv_exc_033_a4","aacv_inc_009_a5"}
def norm(s): return re.sub(r"\s+"," ",(s or "")).strip().lower()
viol=Counter(); coords=[]
def V(kind,p,f): viol[kind]+=1; coords.append((kind,p[-3:],f))
for p in sorted(p for p in os.listdir(base) if os.path.isdir(os.path.join(base,p))):
    dp=os.path.join(base,p,"merged_draft.json" if GROUPED else "agent_draft.json")
    if not os.path.exists(dp): V("NO_DRAFT",p,"-"); continue
    d=json.load(open(dp))
    A={a["field_id"]:a for a in d["field_assessments"]}
    notes=" ||| ".join(norm(open(nf,errors="ignore").read()) for nf in glob.glob(os.path.join(CORP,p,"notes","*.txt")))
    def quote(f):
        return " ".join(norm(e.get("verbatim_quote","")) for e in (A[f].get("evidence") or []))
    for f,a in A.items():
        ans=a["answer"]
        # L1 quote must be verbatim from this patient's notes
        for e in (a.get("evidence") or []):
            q=norm(e.get("verbatim_quote",""))
            if q and q not in notes: V("QUOTE_NOT_IN_NOTES",p,f)
        # L2 undefined-term met needs qualifier IN QUOTE
        if f in UNDEF_MET_ATOMS and ans=="condition_met" and not QUAL.search(quote(f)):
            V("MET_WITHOUT_CHART_QUALIFIER",p,f)
        # L3 allergy not_met needs affirmative negative in quote or rationale
        if f in ALLERGY and ans=="condition_not_met" and not NKDA.search(quote(f)+" "+norm(a.get("rationale",""))):
            V("NOTMET_WITHOUT_AFFIRMATIVE_NEGATIVE",p,f)
        # L4 expected-unknown atoms must not be decided
        if f in EXPECT_UNKNOWN and ans in ("condition_met","condition_not_met"):
            V("DECIDED_EXPECTED_UNKNOWN",p,f)
    # L5 NKDA consistency across allergy atoms
    nm=[f for f in ALLERGY if A.get(f,{}).get("answer")=="condition_not_met"]
    unk=[f for f in ALLERGY if A.get(f,{}).get("answer")=="unknown"]
    if nm and unk and any(NKDA.search(quote(f)) for f in nm): V("NKDA_INCONSISTENT_ACROSS_SIBLINGS",p,"+".join(sorted(unk)))
    # L6 gates
    g=A.get("aacv_exc_025_a1",{}).get("answer")
    for s in ("aacv_exc_025_a2","aacv_exc_025_a3"):
        ss=A.get(s,{}).get("answer")
        if g=="condition_not_met" and ss!="not_applicable": V("GATE_NA_EXPECTED",p,s)
        if g=="unknown" and ss not in ("unknown",None): V("GATE_UNKNOWN_EXPECTED",p,s)
    g=A.get("aacv_inc_002_a1",{}).get("answer"); s=A.get("aacv_inc_002_a2",{}).get("answer")
    if g=="condition_not_met" and s!="not_applicable": V("GATE_NA_EXPECTED",p,"aacv_inc_002_a2")
    if g=="unknown" and s not in ("unknown",None): V("GATE_UNKNOWN_EXPECTED",p,"aacv_inc_002_a2")
    # L7 sex mirror
    x,y=A.get("aacv_inc_002_a1",{}).get("answer"),A.get("aacv_inc_002_a3",{}).get("answer")
    pair={("condition_met","condition_not_met"),("condition_not_met","condition_met"),("unknown","unknown")}
    if (x,y) not in pair: V("SEX_MIRROR_INCONSISTENT",p,f"a1={x},a3={y}")
report={"run_id":run,"n_patients":len([p for p in os.listdir(base) if os.path.isdir(os.path.join(base,p))]),
        "violations_total":sum(viol.values()),"by_kind":dict(viol),
        "items":[{"rule":k,"patient_suffix":p,"field":f} for k,p,f in coords],
        "note":"FLAG-ONLY lint: drafts are never modified. Mechanical rule check; passing it does not establish semantic correctness."}
out=os.path.join(ROOT,"var","aacv-grouped","lint_report.json") if GROUPED else os.path.join(ROOT,"var","runs",run,"lint_report.json")
json.dump(report,open(out,"w"),indent=1)
print(f"[lint] run={run} patients={len([p for p in os.listdir(base) if os.path.isdir(os.path.join(base,p))])}")
print(f"[lint] violations total={sum(viol.values())}  by kind={dict(viol)}")
for c in coords: print(f"[lint]   {c[0]}  {c[1]}  {c[2]}")
print(f"[lint] report written: {os.path.relpath(out,ROOT)}")
sys.exit(0 if not viol else 1)
