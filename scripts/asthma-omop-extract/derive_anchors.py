#!/usr/bin/env python3
"""Derive adherence event-anchor lists from a patient's local OMOP JSON.

Reads corpus/patients/<pid>/omop/{encounters,drugs}.json and writes
corpus/patients/<pid>/anchors/{asthma_encounters,ocs_bursts,obligation_points}.json
(spec 2026-08-24). Qualifying + 14-day-separation logic mirrors the v0.5
foundations block in etl.py — outpatient + ED asthma-related encounters
count, inpatient excluded; a new OCS burst only when >14 days from the
previous burst's START; obligation_points = the date of the 2nd OCS burst
(note-documented obligation points are agent-supplemented at run time,
origin=note). Every date is normalized through parse_date().isoformat()
before it becomes part of an anchor's identity; rows/fills whose date
can't be parsed are skipped and counted rather than silently defaulted.

Anchor-list on-disk order is part of the event-identity contract — entries
are emitted date-ascending and stable.

Usage (from chart-review-platform/):
  python3 scripts/asthma-omop-extract/derive_anchors.py --prefix patient_fake_asthma [--corpus corpus/patients]
"""
import argparse, json, os, sys
from datetime import date


def parse_date(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except (ValueError, TypeError):
        return None


def _clean_rows(rows, table, pid):
    """Defensive filter for a just-loaded omop table.

    `rows` must be a list of dict rows. If it isn't a list at all, warn
    and treat as empty. Any non-dict entries within the list are dropped
    with a warning (naming the patient + table) so a malformed upstream
    extract can't crash the whole batch.
    """
    if not isinstance(rows, list):
        print(f"[anchors] WARNING: {pid}: {table}.json is not a list "
              f"(got {type(rows).__name__}); treating as empty", file=sys.stderr)
        return []
    out, dropped = [], 0
    for r in rows:
        if isinstance(r, dict):
            out.append(r)
        else:
            dropped += 1
    if dropped:
        print(f"[anchors] WARNING: {pid}: {table}.json dropped {dropped} "
              f"non-dict row(s)", file=sys.stderr)
    return out


def asthma_encounter_anchors(encounters, stats=None):
    """Outpatient + ED asthma-related encounters, date-ascending.

    Qualifying test mirrors the v0.5 foundations block in etl.py: a row
    counts when `asthma_related` is true and `type` is not an Inpatient
    visit. The `asthma_related` flag is itself computed upstream (in the
    ETL) from a separate asthma-diagnosis join that isn't persisted
    per-patient, so it can only be READ here, not recomputed from
    encounters.json alone — a row that omits the key is treated as
    not-asthma-related (safe default). `is_ed` is read when present;
    otherwise inferred from `type` containing "emergency"
    (case-insensitive), matching etl.py's visit_concept_id==9203 ->
    "Emergency Room Visit" mapping.

    `date` is emitted as parse_date(...).isoformat() — never the raw
    field — so anchor identity is normalized even if the source uses a
    timestamp-with-time value. If `stats` (a dict) is given, each
    qualifying row whose start_date fails to parse increments
    stats["skipped"] and is excluded (not defaulted to any date).
    """
    if stats is None:
        stats = {}
    out = []
    for r in encounters:
        if not r.get("asthma_related", False):
            continue
        typ = r.get("type") or ""
        if "Inpatient" in typ:
            continue
        d = parse_date(r.get("start_date"))
        if d is None:
            stats["skipped"] = stats.get("skipped", 0) + 1
            continue
        is_ed = r.get("is_ed")
        if is_ed is None:
            is_ed = "emergency" in typ.lower()
        out.append({
            "date": d.isoformat(),
            "ref": f"encounters:{r.get('row_id')}",
            "meta": {"kind": "ed" if is_ed else "outpatient"},
        })
    out.sort(key=lambda x: (x["date"], str(x["ref"])))
    return out


def ocs_burst_anchors(drugs, stats=None):
    """OCS burst starts with 14-day event separation (mirrors etl.py).

    Collects every fill_date across all drugs rows with
    drug_class == "OCS", then applies the v0.5 foundations block's rule:
    a new burst starts only when its fill_date is >14 days after the
    previous burst's START date (fills within 14 days are the same
    prolonged/undertreated course, not a new burst). This deliberately
    does NOT fold in ED/inpatient encounters the way etl.py's broader
    exacerbation counter does — bursts here are OCS-fill-only, a
    narrower and different measure.

    `date` is emitted as parse_date(...).isoformat(). Fills are sorted
    with an explicit tiebreak — (date, str(row_id)) — so same-date fills
    from different drug rows land in a deterministic order and collapse
    into a single burst. If `stats` (a dict) is given, each fill whose
    fill_date fails to parse increments stats["skipped"] and is excluded.
    """
    if stats is None:
        stats = {}
    fills = []
    for e in drugs:
        if e.get("drug_class") != "OCS":
            continue
        row_id = e.get("row_id")
        for f in (e.get("fills") or []):
            if not isinstance(f, dict):
                continue
            d = parse_date(f.get("fill_date"))
            if d is None:
                stats["skipped"] = stats.get("skipped", 0) + 1
                continue
            fills.append((d, row_id))
    fills.sort(key=lambda x: (x[0], str(x[1])))
    bursts, last_start = [], None
    for d, row_id in fills:
        if last_start is None or (d - last_start).days > 14:
            bursts.append({"date": d.isoformat(), "ref": f"drugs:{row_id}"})
            last_start = d
    return bursts


def obligation_point_anchors(bursts):
    """The 2nd OCS burst establishes the controller-therapy obligation.

    Unlike etl.py's broader exacerbation counter — which also merges
    ED/inpatient asthma-related encounters into the same 14-day-separated
    event set — this looks at OCS bursts only, so "2nd burst" here is a
    narrower, deliberately different measure than etl.py's exacerbation
    count.
    """
    return bursts[1:2]


def derive_for_patient(patient_dir):
    pid = os.path.basename(os.path.normpath(patient_dir))
    omop_dir = os.path.join(patient_dir, "omop")

    def load_table(name):
        p = os.path.join(omop_dir, f"{name}.json")
        if not os.path.exists(p):
            return []
        with open(p) as f:
            try:
                rows = json.load(f)
            except json.JSONDecodeError as e:
                raise ValueError(f"malformed JSON in {p}: {e}") from e
        return _clean_rows(rows, name, pid)

    encounters = load_table("encounters")
    drugs = load_table("drugs")
    stats = {"skipped": 0}
    enc_anchors = asthma_encounter_anchors(encounters, stats)
    bursts = ocs_burst_anchors(drugs, stats)
    obligation = obligation_point_anchors(bursts)

    adir = os.path.join(patient_dir, "anchors")
    os.makedirs(adir, exist_ok=True)
    counts = {"skipped": stats["skipped"]}
    for name, rows in (("asthma_encounters", enc_anchors), ("ocs_bursts", bursts), ("obligation_points", obligation)):
        with open(os.path.join(adir, f"{name}.json"), "w") as f:
            json.dump(rows, f, indent=1)
            f.write("\n")
        counts[name] = len(rows)
    return counts


def main():
    ap = argparse.ArgumentParser(
        description="Derive adherence event-anchor lists (asthma_encounters, "
                     "ocs_bursts, obligation_points) from each matching patient's "
                     "local OMOP JSON under --corpus.")
    ap.add_argument("--corpus", default="corpus/patients",
                     help="root directory containing patient_* subdirectories (default: corpus/patients)")
    ap.add_argument("--prefix", required=True,
                     help="only process patient dirs whose name starts with this prefix "
                          "(e.g. patient_fake_asthma or patient_real_asthma) — required, no default, "
                          "to avoid accidentally processing the whole corpus")
    a = ap.parse_args()
    n, errors = 0, 0
    for pid in sorted(os.listdir(a.corpus)):
        if not pid.startswith(a.prefix):
            continue
        pdir = os.path.join(a.corpus, pid)
        if not os.path.isdir(os.path.join(pdir, "omop")):
            continue
        try:
            counts = derive_for_patient(pdir)
        except Exception as e:
            print(f"[anchors] ERROR {pid}: {e}", file=sys.stderr)
            errors += 1
            continue
        skip_sfx = f" skipped={counts['skipped']}" if counts.get("skipped") else ""
        print(f"[anchors] {pid}: encounters={counts['asthma_encounters']} bursts={counts['ocs_bursts']} obligation={counts['obligation_points']}{skip_sfx}")
        n += 1
    if n == 0:
        print(f"[anchors] WARNING: 0 patients matched --prefix {a.prefix!r} under {a.corpus!r}", file=sys.stderr)
        sys.exit(1)
    suffix = f" ({errors} error(s))" if errors else ""
    print(f"[anchors] wrote anchors for {n} patients{suffix}")


if __name__ == "__main__":
    main()
