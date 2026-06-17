"""Deterministic structured floor for RUCAM Item 5 (exclusion of other causes).

Why this exists: on real data the agent emitted a rote `item_5 = +1` on every
patient ("all causes excluded") while human adjudicators scored −2/−3 — it
asserted exclusions instead of doing the per-cause work the rubric mandates.

This tool computes, from STRUCTURED data only, each cause's exclusion status
under the rubric's strict rule:
  - a NEGATIVE test result        -> (a) ruled out
  - a POSITIVE test / present dx  -> competing cause, NOT excluded
  - no test, flag absent/0        -> (c) not assessed  (NOT ruled out)
Flag == 0 is NOT an exclusion (per item-5-exclusion.md: "flag = 0 alone is
NOT (b)"). So from structure alone most flag-based causes are (c), and the
recommended floor lands at 0 or −2 — the agent can only RAISE it by citing
explicit note-based exclusions, which forces the per-cause reasoning.

This is a FLOOR + breakdown, not the final answer: the agent still sets
item_5_exclusion, but must justify any score above the floor with note evidence
(and may go lower if a competing cause is probable).
"""
from pathlib import Path
from typing import Optional

import pandas as pd

# Group I (the 6 RUCAM "rule out first" causes) -> the derived_rucam columns
# that evidence them. *_result columns are qualitative serologies; the rest are
# diagnosis/procedure/flag columns.
GROUP_I = {
    "HAV (acute)": {"results": ["HAV_IgM_result"], "flags": []},
    "HBV": {"results": ["HBsAg_result", "HBc_IgM_result"], "flags": ["chronic_hep_B_hx"]},
    "HCV": {"results": ["HCV_Ab_result", "HCV_RNA_result"], "flags": ["chronic_hep_C_hx"]},
    "Biliary obstruction": {"results": [], "flags": ["biliary_obstruction_dx"]},
    "Alcohol": {"results": [], "flags": ["alcohol_use_disorder", "alcoholic_liver_disease"]},
    "Hypotension/ischemia": {"results": [],
        "flags": ["hypotension_14d", "shock_14d", "ischemic_hepatitis_14d",
                  "acute_MI_14d", "sbp_low_flag_14d"]},
}
GROUP_II = {
    "Autoimmune hepatitis": {"results": ["ANA_result", "SMA_result"], "flags": ["autoimmune_hepatitis_hx"]},
    "Acute CMV": {"results": ["CMV_IgM_result", "CMV_PCR_result"], "flags": ["CMV_acute_dx"]},
    "Acute EBV": {"results": ["EBV_VCA_IgM_result", "EBV_PCR_result", "EBV_result"], "flags": ["EBV_acute_dx"]},
    "Acute HSV": {"results": ["HSV_PCR_result"], "flags": ["HSV_hepatitis_dx"]},
    "Sepsis/bacteremia": {"results": [], "flags": ["sepsis_dx", "septicemia_dx", "bacteremia_dx"]},
}

_POS = {"positive", "pos", "reactive", "detected", "high", "abnormal"}
_NEG = {"negative", "neg", "nonreactive", "non-reactive", "not detected", "normal", "none"}


def _result_status(val) -> Optional[str]:
    """'pos' | 'neg' | None(unknown) for a qualitative result cell."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    s = str(val).strip().lower()
    if not s or s in {"nan", "na", "n/a", "unknown", "none"}:
        return None
    if any(t in s for t in _POS):
        return "pos"
    if any(t in s for t in _NEG):
        return "neg"
    return None


def _flag_present(val) -> bool:
    """True if a dx/proc/flag column indicates the condition is PRESENT."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return False
    s = str(val).strip().lower()
    if s in {"", "0", "0.0", "false", "no", "nan", "na"}:
        return False
    try:
        return float(s) != 0.0
    except ValueError:
        return s in {"1", "true", "yes", "y", "present", "positive"}


def _cause_status(row, spec) -> dict:
    """Classify one cause -> {status, detail}. status in
    'present' | 'ruled_out' | 'not_assessed'."""
    present = []
    ruled = []
    for col in spec["results"]:
        if col not in row:
            continue
        st = _result_status(row[col])
        if st == "pos":
            present.append(f"{col}=positive")
        elif st == "neg":
            ruled.append(f"{col}=negative")
    for col in spec["flags"]:
        if col in row and _flag_present(row[col]):
            present.append(f"{col} present")
    if present:
        return {"status": "present", "detail": "; ".join(present)}
    if ruled:
        return {"status": "ruled_out", "detail": "; ".join(ruled)}
    return {"status": "not_assessed", "detail": "no negative test / flag absent (flag=0 is not an exclusion)"}


def score_item5_exclusion(person_id: int, data_dir: str = "data") -> dict:
    """STRUCTURED floor for RUCAM Item 5. Reads derived_rucam.csv only.

    Returns:
      recommended_floor: int in {2,1,0,-2,-3} — start here; RAISE only with
                         explicit note-based exclusions, LOWER if a competing
                         cause is probable.
      group_i / group_ii: {cause: {status, detail}} where status is
                         'ruled_out' (a, negative test), 'present' (competing
                         cause — NOT excluded), or 'not_assessed' (c — needs a
                         note to become (b); flag=0 does NOT count).
      group_i_ruled_out: count of Group I causes ruled out by a negative test.
      competing_causes: causes with a positive marker / present diagnosis.
      note: how to use this floor.
    """
    path = Path(data_dir) / "derived_rucam.csv"
    if not path.exists():
        return {"result": [], "message": f"derived_rucam.csv not found in {data_dir}"}
    df = pd.read_csv(path)
    rows = df[df["PERSON_ID"] == person_id]
    if rows.empty:
        return {"result": [], "message": f"No data found for person_id={person_id}"}
    row = rows.iloc[0].to_dict()

    gi = {c: _cause_status(row, spec) for c, spec in GROUP_I.items()}
    gii = {c: _cause_status(row, spec) for c, spec in GROUP_II.items()}
    competing = [c for c, v in {**gi, **gii}.items() if v["status"] == "present"]
    gi_ruled = sum(1 for v in gi.values() if v["status"] == "ruled_out")
    gii_ruled = sum(1 for v in gii.values() if v["status"] == "ruled_out")

    if competing:
        floor = -2  # a non-drug cause is present and not excluded (use -3 if it clearly explains the injury)
        reason = (f"competing cause(s) present and not excluded: {', '.join(competing)} "
                  f"-> structured floor -2 (consider -3 if it explains the injury)")
    elif gi_ruled >= 6 and gii_ruled == len(GROUP_II):
        floor, reason = 2, "all Group I + Group II ruled out by negative tests"
    elif gi_ruled >= 6:
        floor, reason = 1, "all 6 Group I ruled out by negative tests; Group II uncertain"
    elif gi_ruled >= 4:
        floor, reason = 0, f"{gi_ruled}/6 Group I ruled out by negative tests"
    else:
        floor, reason = -2, (f"only {gi_ruled}/6 Group I ruled out by a negative test "
                             f"(the rest are not assessed in structured data — flag=0 is not an exclusion)")

    return {
        "recommended_floor": floor,
        "group_i_ruled_out": gi_ruled,
        "competing_causes": competing,
        "group_i": gi,
        "group_ii": gii,
        "reasoning": reason,
        "note": ("This is a STRUCTURED-ONLY floor. RAISE the score only by citing "
                 "explicit note exclusions for 'not_assessed' causes (each negative "
                 "test or explicit 'denies/no evidence of' upgrades a cause to ruled "
                 "out). Do NOT score above the floor without note evidence. LOWER it "
                 "(toward -3) if a competing cause clearly explains the injury."),
    }
