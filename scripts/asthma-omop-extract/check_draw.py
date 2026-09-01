#!/usr/bin/env python3
"""check_draw.py — is this calibration draw able to measure the rubric?

Run AFTER the ETL and BEFORE anyone annotates. The cohort summary tells you the
extraction worked; this tells you whether the patients you drew can exercise the
rules. Those are different questions, and only this one is expensive to get wrong:
an annotator spends a day on 30 charts and the rule you most wanted to measure
turns out to have had no events.

The check that matters most is `obligation_points`. It is the date a daily
controller became owed, derived from the exacerbation history — the 2nd
exacerbation (OCS course, asthma ED visit, or asthma admission) within a rolling
year. R-T1-ControllerForPersistent anchors on it, so a patient without one is not
measured on that rule at all. If it is zero across the whole draw, the draw cannot
calibrate the study's most important requirement.

Prints counts and pseudonymous ids only — no dates, no note text, no PHI. The
output is safe to send to the coordinating centre.

Usage (from the platform root):
    python3 scripts/asthma-omop-extract/check_draw.py
    python3 scripts/asthma-omop-extract/check_draw.py --corpus corpus/patients --prefix patient_real_asthma_wcm_
"""
import argparse
import glob
import json
import os
import statistics
import sys

ANCHORS = ("asthma_encounters", "ocs_bursts", "exacerbations", "obligation_points")
BANDS = ("age_2_4", "age_5_11", "age_12_17")

# A rule needs events to be measurable at all; a band needs patients to be
# calibratable. Both are advisory thresholds — the coordinating centre sets them.
MIN_PER_BAND = 3
MIN_WITH_OBLIGATION = 1
THIN_NOTES = 5
SPIROMETRY_LOOKBACK_DAYS = 730


def count_json(path):
    """Length of a JSON array file; None when absent, -1 when unreadable."""
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            rows = json.load(f)
        return len(rows) if isinstance(rows, list) else -1
    except (json.JSONDecodeError, OSError):
        return -1


def read_patient(pdir):
    pid = os.path.basename(pdir.rstrip("/"))
    out = {"id": pid}
    meta_path = os.path.join(pdir, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
        except (json.JSONDecodeError, OSError):
            meta = {}
    out["days_observed"] = meta.get("days_observed_before_index")
    out["notes_12mo"] = meta.get("n_notes_12mo")

    demo = os.path.join(pdir, "omop", "demographics.json")
    out["age_band"] = None
    if os.path.exists(demo):
        try:
            with open(demo) as f:
                rows = json.load(f)
            if rows:
                out["age_band"] = rows[0].get("age_band")
        except (json.JSONDecodeError, OSError):
            pass

    out["n_notes_files"] = len(glob.glob(os.path.join(pdir, "notes", "*.txt")))
    for name in ANCHORS:
        out[name] = count_json(os.path.join(pdir, "anchors", f"{name}.json"))
    return out


def fmt(v):
    if v is None:
        return "-"
    if v == -1:
        return "ERR"
    return str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="corpus/patients")
    ap.add_argument("--prefix", default="patient_real_asthma_",
                    help="only patients whose directory name starts with this")
    a = ap.parse_args()

    dirs = sorted(d for d in glob.glob(os.path.join(a.corpus, a.prefix + "*"))
                  if os.path.isdir(d))
    if not dirs:
        print(f"no patient directories matching {a.prefix}* under {a.corpus}")
        return 2
    rows = [read_patient(d) for d in dirs]

    print(f"{'patient':44} {'band':11} {'notes12':>7} {'days_obs':>8} "
          f"{'enc':>4} {'ocs':>4} {'exac':>5} {'oblig':>5}")
    print("-" * 100)
    for r in rows:
        print(f"{r['id']:44} {str(r['age_band'] or '-'):11} "
              f"{fmt(r['notes_12mo']):>7} {fmt(r['days_observed']):>8} "
              f"{fmt(r['asthma_encounters']):>4} {fmt(r['ocs_bursts']):>4} "
              f"{fmt(r['exacerbations']):>5} {fmt(r['obligation_points']):>5}")

    n = len(rows)
    print(f"\n{n} patient(s)\n")

    def ints(key):
        return [r[key] for r in rows if isinstance(r[key], int) and r[key] >= 0]

    for key, label in (("asthma_encounters", "asthma_encounters"),
                       ("ocs_bursts", "ocs_bursts"),
                       ("exacerbations", "exacerbations"),
                       ("obligation_points", "obligation_points")):
        v = ints(key)
        if not v:
            print(f"  {label:20} NO DATA — anchors missing or unreadable")
            continue
        nonzero = sum(1 for x in v if x > 0)
        print(f"  {label:20} total {sum(v):>5}   patients with >=1: {nonzero:>3}/{n}"
              f"   median {statistics.median(v):>5}   max {max(v)}")

    print("\nCHECKS")
    problems = 0

    withob = sum(1 for r in rows if isinstance(r["obligation_points"], int)
                 and r["obligation_points"] > 0)
    if withob < MIN_WITH_OBLIGATION:
        problems += 1
        print("  FAIL  no patient has an obligation point. R-T1-ControllerForPersistent")
        print("        anchors on those, so this draw cannot measure it at all —")
        print("        re-draw with exacerbation history as a stratum.")
    else:
        print(f"  ok    {withob}/{n} patient(s) have an obligation point "
              f"(R-T1-ControllerForPersistent has a denominator)")

    bands = {b: sum(1 for r in rows if r["age_band"] == b) for b in BANDS}
    unknown = [r["id"] for r in rows if r["age_band"] not in BANDS]
    for b, c in bands.items():
        if c < MIN_PER_BAND:
            problems += 1
            print(f"  WARN  age band {b}: {c} patient(s) — that band has its own guideline")
            print(f"        logic, and it cannot be calibrated from fewer than ~{MIN_PER_BAND}")
        else:
            print(f"  ok    age band {b}: {c} patient(s)")
    if unknown:
        problems += 1
        print(f"  FAIL  {len(unknown)} patient(s) have an age_band outside "
              f"{BANDS} — the rubric keys on those exact values")
        for pid in unknown[:5]:
            print(f"        {pid}")

    notes = ints("notes_12mo")
    if notes:
        thin = sum(1 for x in notes if x <= THIN_NOTES)
        line = (f"  {'WARN' if thin > n // 4 else 'ok  '}  notes in the 12-month window: "
                f"median {statistics.median(notes)}, {thin}/{n} at or below {THIN_NOTES}")
        print(line)
        if thin > n // 4:
            problems += 1
            print("        a thin chart answers 'not documented' to most T2 questions")
            print("        because the data is thin, not the care — raise @min_notes_12mo")
    else:
        print("  WARN  n_notes_12mo missing from meta.json (extraction predates it)")

    days = ints("days_observed")
    if days:
        short = sum(1 for x in days if x < SPIROMETRY_LOOKBACK_DAYS)
        print(f"  ok    prior observation: median {statistics.median(days)}, "
              f"{short}/{n} under {SPIROMETRY_LOOKBACK_DAYS} days "
              f"(those are censored on the spirometry rule)")
        if short == 0:
            print("        none censored — if your observation_period is a synthesized")
            print("        earliest-record proxy, expect that, and say so with the results")
    else:
        print("  WARN  days_observed_before_index missing from meta.json "
              "(extraction predates it)")

    nonotes = [r["id"] for r in rows if r["n_notes_files"] == 0]
    if nonotes:
        problems += 1
        print(f"  FAIL  {len(nonotes)} patient(s) have no note files at all")
        for pid in nonotes[:5]:
            print(f"        {pid}")

    print(f"\n{'no blocking problems found' if problems == 0 else str(problems) + ' item(s) above to resolve'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
