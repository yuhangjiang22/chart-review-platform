#!/usr/bin/env python3
"""Derive adherence event-anchor lists from a patient's local OMOP JSON.

Reads corpus/patients/<pid>/omop/{encounters,drugs}.json and writes
corpus/patients/<pid>/anchors/{asthma_encounters,ocs_bursts,obligation_points}.json
(spec 2026-08-24). Qualifying + 14-day-separation logic mirrors the v0.5
foundations in etl.py — outpatient + ED asthma-related encounters count,
inpatient excluded; a new OCS burst only when >14 days from the previous
burst's START; obligation_points = the SECOND burst's date (>=2 exacerbations
establishes the controller obligation; note-documented obligation points are
agent-supplemented at run time, origin=note).

Anchor-list on-disk order is part of the event-identity contract — entries
are emitted date-ascending and stable.

Usage (from chart-review-platform/):
  python3 scripts/asthma-omop-extract/derive_anchors.py [--corpus corpus/patients] [--prefix patient_]
"""
import argparse, json, os
from datetime import date


def parse_date(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except (ValueError, TypeError):
        return None


def asthma_encounter_anchors(encounters):
    """Outpatient + ED asthma-related encounters, date-ascending.

    Qualifying test mirrors etl.py's v0.5 foundations block (~189-197):
    a row counts when `asthma_related` is true and `type` is not an
    Inpatient visit. The `asthma_related` flag is itself computed
    upstream (in the ETL) from a separate asthma-diagnosis join that
    isn't persisted per-patient, so it can only be READ here, not
    recomputed from encounters.json alone — a row that omits the key
    is treated as not-asthma-related (safe default; see report for the
    fixture gap this produces on patient_fake_asthma_smart_01).
    `is_ed` is read when present; otherwise inferred from `type`
    containing "emergency" (case-insensitive), matching etl.py's
    visit_concept_id==9203 -> "Emergency Room Visit" mapping.
    """
    out = []
    for r in encounters:
        if not r.get("asthma_related", False):
            continue
        typ = r.get("type") or ""
        if "Inpatient" in typ:
            continue
        is_ed = r.get("is_ed")
        if is_ed is None:
            is_ed = "emergency" in typ.lower()
        out.append({
            "date": r.get("start_date"),
            "ref": f"encounters:{r.get('row_id')}",
            "meta": {"kind": "ed" if is_ed else "outpatient"},
        })
    out.sort(key=lambda x: (x["date"] or "", str(x["ref"])))
    return out


def ocs_burst_anchors(drugs):
    """OCS burst starts with 14-day event separation (mirrors etl.py).

    Collects every fill_date across all drugs rows with
    drug_class == "OCS", then applies etl.py's ~206-214 rule: a new
    burst starts only when its fill_date is >14 days after the
    previous burst's START date (fills within 14 days are the same
    prolonged/undertreated course, not a new burst).
    """
    fills = []
    for e in drugs:
        if e.get("drug_class") != "OCS":
            continue
        row_id = e.get("row_id")
        for f in (e.get("fills") or []):
            d = f.get("fill_date")
            if d:
                fills.append((d, row_id))
    fills.sort(key=lambda x: x[0])
    bursts, last_start = [], None
    for d_str, row_id in fills:
        d = parse_date(d_str)
        if d is None:
            continue
        if last_start is None or (d - last_start).days > 14:
            bursts.append({"date": d_str, "ref": f"drugs:{row_id}"})
            last_start = d
    return bursts


def obligation_point_anchors(bursts):
    """The 2nd burst establishes the controller obligation."""
    return bursts[1:2]


def derive_for_patient(patient_dir):
    omop_dir = os.path.join(patient_dir, "omop")

    def load_table(name):
        p = os.path.join(omop_dir, f"{name}.json")
        if not os.path.exists(p):
            return []
        with open(p) as f:
            return json.load(f)

    encounters = load_table("encounters")
    drugs = load_table("drugs")
    enc_anchors = asthma_encounter_anchors(encounters)
    bursts = ocs_burst_anchors(drugs)
    obligation = obligation_point_anchors(bursts)

    adir = os.path.join(patient_dir, "anchors")
    os.makedirs(adir, exist_ok=True)
    counts = {}
    for name, rows in (("asthma_encounters", enc_anchors), ("ocs_bursts", bursts), ("obligation_points", obligation)):
        with open(os.path.join(adir, f"{name}.json"), "w") as f:
            json.dump(rows, f, indent=1)
        counts[name] = len(rows)
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="corpus/patients")
    ap.add_argument("--prefix", default="patient_")
    a = ap.parse_args()
    n = 0
    for pid in sorted(os.listdir(a.corpus)):
        if not pid.startswith(a.prefix):
            continue
        pdir = os.path.join(a.corpus, pid)
        if not os.path.isdir(os.path.join(pdir, "omop")):
            continue
        counts = derive_for_patient(pdir)
        print(f"[anchors] {pid}: encounters={counts['asthma_encounters']} bursts={counts['ocs_bursts']} obligation={counts['obligation_points']}")
        n += 1
    print(f"[anchors] wrote anchors for {n} patients")


if __name__ == "__main__":
    main()
