#!/usr/bin/env python3
"""Derive adherence event-anchor lists from a patient's local OMOP JSON.

Reads corpus/patients/<pid>/omop/{demographics,encounters,drugs}.json and
writes corpus/patients/<pid>/anchors/{asthma_encounters,ocs_bursts,
exacerbations,obligation_points}.json (spec 2026-08-24, revised 2026-08-27).

Six decisions are baked in here; all six were audit findings against the
study documents, so each carries its source:

1. OBSERVATION WINDOW. Every anchor list is restricted to the 12 months
   ending on the patient's index_date. The v0.6 lists had no date predicate
   at all and carried the patient's whole history — 70% of anchor events sat
   outside the window, some up to 9 years before index, inflating the step-
   therapy and follow-up denominators ~3.4x. Both study documents scope the
   audit to 12 months (annotator SOP v0.5 §3 "most questions cover the 12
   months before the index date"; team update, eligibility + exacerbation +
   SABA rows).

2. ONE EVENT PER VISIT-DAY. asthma_encounters collapses same-day encounters
   into a single anchor. Judging "does the regimen match step therapy" five
   times on one calendar day is not five independent opportunities — it is
   one clinical decision point. This also neutralises the upstream
   `asthma_related` flag being computed per-DATE rather than per-encounter
   (etl.py: `(row_id in avid) or (start_date in adate)`), which flagged every
   encounter sharing a day with an asthma diagnosis: 80% of in-window anchor
   events came from multi-encounter days where at most one encounter actually
   carried the diagnosis.

3. EXACERBATION = OCS COURSE, ASTHMA ED VISIT, OR ASTHMA ADMISSION. The
   controller obligation is established by the 2nd exacerbation, and both
   study documents define an exacerbation with all three arms (annotator SOP
   v0.5, T1-ExacerbationsCount; team update, same row). The v0.6 obligation
   anchor used OCS prescriptions alone, which in this data misses most
   ED-treated exacerbations — 85% of asthma ED visits carry no OCS drug row
   within +/-1 day, because ED-administered steroids are not captured in
   drug_exposure. `ocs_bursts` stays OCS-only and unchanged: the follow-up
   rule anchors on it, and folding ED visits in there would double-count
   against the same day's asthma_encounters anchor.

4. GRACE DEADLINE ON THE OBLIGATION. Each obligation point carries the date
   by which a controller must be active for the obligation to be met: the
   patient's next asthma visit after the obligation date. The obligation date
   itself is an opportunity (a visit on that day counts). Determining this
   from dates is deterministic work, so it is computed here rather than left
   to the agent or annotator to derive.

5. AN OCS COURSE COUNTS ONLY WHEN IT IS ATTRIBUTABLE TO ASTHMA. Both study
   documents require it — annotator SOP v0.5 defines an exacerbation as an
   "oral steroid burst, ED visit, or hospitalization FOR ASTHMA", and the team
   update as "a NEW short-course systemic corticosteroid script ... FOR
   ASTHMA". Earlier revisions took every systemic-steroid fill regardless of
   indication, and in this cohort that is not a small effect: of 126,134 OCS
   drug_exposure rows, only 45.7% sit on a visit carrying an asthma diagnosis.
   Dexamethasone is 40.7% of all OCS rows and only 35.7% of it is
   asthma-linked, because in paediatrics it is the standard treatment for
   CROUP — whose peak incidence is ages 2-5, exactly this study's lower age
   band.

   The events that resulted were not merely extra, they were guaranteed
   failures. A well-controlled 3-year-old with two croup episodes got two
   `ocs_bursts` (asking whether asthma follow-up was arranged after each) plus
   an `obligation_points` event asserting a daily controller was owed — and
   `R-T1-ControllerForPersistent` has no `event_evaluable_if`, so nothing
   downstream could reject it: the agent could only answer truthfully that no
   controller was prescribed, and the rule scored a care gap that never
   happened. Three fabricated non-concordances from one child's croup, biasing
   the measured adherence rate DOWNWARD.

   Attribution is by DATE PROXIMITY to an asthma-flagged encounter
   (OCS_ASTHMA_ATTRIBUTION_DAYS), not by the drug row's visit link: the drugs
   extract carries no visit_occurrence_id, and a date window is the more
   robust test anyway — a discharge prescription is routinely written against
   a different visit than the one that produced it. Inpatient encounters count
   as attributing evidence here (unlike decision 2, which excludes them from
   step-therapy decision points): a steroid course at discharge from an asthma
   admission is exactly an asthma course.

   NOT implemented: the documents' "typically 3-10 days" duration. "Typically"
   is not a filter, and applying it as one would drop real asthma bursts at
   both ends — single-dose dexamethasone is used for asthma too, and 3-week
   tapers exist. Asthma attribution is the load-bearing test; duration would
   only add false negatives on top of it.

6. THE ANCHOR'S SETTING (meta.kind) IS DECIDED FROM LINKED ENCOUNTERS ONLY.
   See asthma_encounter_anchors' docstring. Short version: `asthma_related` is
   a DAY-level flag by design (8.0% of J45 condition rows have no
   visit_occurrence_id, so a link-only test would discard real asthma visits),
   which means every unrelated visit sharing a day with an asthma diagnosis
   inherits it — 331,596 encounters in this extract. Same-day collapsing
   already absorbs that into one anchor, but the anchor's OUTPATIENT-vs-ED
   label was still computed over all of them, so an asthma ED visit sharing a
   date with an orthopedics appointment came out labelled outpatient: 6,322 of
   the 30,257 ED-only asthma days (21%). That label carries the study's
   per-setting stratification. Encounters whose diagnosis genuinely points at
   them (`asthma_dx_linked`, added to etl.py's encounter rows for this) now
   decide the setting; the date fallback decides it only when no encounter that
   day is linked, which is what the fallback exists for. `meta.kind_from`
   records which of the two applied.

Every date is normalized through parse_date().isoformat() before it becomes
part of an anchor's identity; rows/fills whose date can't be parsed are
skipped and counted rather than silently defaulted.

Anchor-list on-disk order is part of the event-identity contract — entries
are emitted date-ascending and stable.

Usage (from chart-review-platform/):
  python3 scripts/asthma-omop-extract/derive_anchors.py --prefix patient_fake_asthma [--corpus corpus/patients]
"""
import argparse, json, os, sys
from datetime import date, timedelta

WINDOW_DAYS = 365
BURST_SEPARATION_DAYS = 14

# Decision 5: how far either side of an asthma-flagged encounter an OCS fill may
# sit and still be attributed to asthma. Set from the measured curve on the real
# extract (126,134 OCS fills, 63,125 patients with an asthma-flagged date) —
# share of fills that attribute at each width:
#
#     +/-0   37.8%     +/-7   54.6%      +/-30  61.2%
#     +/-3   51.7%     +/-14  57.2%
#
# The knee is 0 -> 3 (+13.9pp), which is the discharge-prescription lag: a burst
# written at a visit and filled a day or two later. After that the curve flattens
# to slow drift (+2.9, +2.6, +4.0) — these are asthma patients, so a wider window
# buys attribution by coincidence rather than by indication. 7 sits just past the
# knee, covering the two real lags (discharge fills, and a burst written at a
# phone follow-up after an ED visit) without letting a February croup episode
# borrow attribution from a March asthma check-up.
#
# Consistency check on the whole approach: dexamethasone attributes LEAST at
# every width (41.7% at +/-7 vs 61-65% for prednisone/prednisolone), which is
# what croup being a large share of paediatric dexamethasone predicts.
OCS_ASTHMA_ATTRIBUTION_DAYS = 7
OBLIGATION_LOOKBACK_DAYS = 365


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


def window_for(index_date):
    """(lo, hi] observation window: the 12 months ending on index_date.

    Returns None when index_date is missing/unparseable — callers then fall
    back to emitting nothing rather than silently reverting to whole-history
    behaviour, which is the defect this window exists to fix.
    """
    if index_date is None:
        return None
    return (index_date - timedelta(days=WINDOW_DAYS), index_date)


def _in_window(d, win):
    return win is not None and win[0] < d <= win[1]


def _is_ed(row, typ):
    is_ed = row.get("is_ed")
    if is_ed is None:
        # matches etl.py's visit_concept_id==9203 -> "Emergency Room Visit"
        is_ed = "emergency" in typ.lower()
    return bool(is_ed)


def asthma_encounter_anchors(encounters, win, stats=None):
    """One anchor per asthma-related, non-inpatient VISIT-DAY in the window.

    Qualifying test mirrors the v0.5 foundations block in etl.py: a row
    counts when `asthma_related` is true and `type` is not an Inpatient
    visit. The `asthma_related` flag is computed upstream and can only be
    READ here — a row that omits the key is treated as not-asthma-related
    (safe default).

    Same-day rows collapse into one anchor (decision 2 in the module
    docstring). The surviving `ref` is the lexicographically first row_id on
    that day, so the choice is deterministic and reproducible.

    `meta.kind` is "outpatient" when any qualifying encounter that day was
    non-ED, else "ed" — a day carrying both an ED visit and a clinic visit IS an
    outpatient decision point. The ED/outpatient stratification of the
    step-therapy results reads this field.

    THE SETTING IS DECIDED FROM LINKED ENCOUNTERS ONLY (decision 6). `asthma_related`
    is permissive by design: 8.0% of J45 condition rows carry no
    visit_occurrence_id, so the flag falls back to "any visit on a day with an
    asthma diagnosis", which also flags every unrelated visit that day
    (331,596 encounters in this extract). Same-day collapsing means that costs
    no extra anchors — but it did cost the LABEL: an asthma ED visit sharing a
    date with an orthopedics appointment was called OUTPATIENT, because the
    orthopedics row is non-ED and had inherited the flag. 6,322 of the 30,257
    ED-only asthma days (21%). So when any encounter that day carries
    `asthma_dx_linked` (etl.py: the diagnosis genuinely points at that visit),
    only those decide the setting. When none does — the 5.7% of asthma-dx days
    whose diagnosis row had no visit link at all — every flagged encounter
    decides it, which is the fallback's whole purpose. A row omitting the key
    reads as not-linked, so an extract predating the field keeps the old
    behaviour rather than silently changing.

    If `stats` (a dict) is given, each qualifying row whose start_date fails
    to parse increments stats["skipped"] and is excluded (not defaulted to
    any date); rows falling outside the window increment
    stats["out_of_window"].
    """
    if stats is None:
        stats = {}
    by_day = {}
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
        if not _in_window(d, win):
            stats["out_of_window"] = stats.get("out_of_window", 0) + 1
            continue
        key = d.isoformat()
        slot = by_day.setdefault(key, {"refs": [], "linked": [], "all": []})
        slot["refs"].append(str(r.get("row_id")))
        is_ed = _is_ed(r, typ)
        slot["all"].append(is_ed)
        if r.get("asthma_dx_linked") is True:
            slot["linked"].append(is_ed)
    out = []
    for day in sorted(by_day):
        slot = by_day[day]
        # Linked encounters decide the setting when there are any; otherwise
        # every flagged encounter does (see the docstring).
        basis = slot["linked"] or slot["all"]
        out.append({
            "date": day,
            "ref": f"encounters:{sorted(slot['refs'])[0]}",
            "meta": {
                "kind": "outpatient" if any(not ed for ed in basis) else "ed",
                "n_encounters": len(slot["refs"]),
                # How the setting above was decided, so a reviewer reading a
                # surprising label can tell whether it rests on a linked
                # diagnosis or on the date fallback.
                "kind_from": "linked_dx" if slot["linked"] else "date_fallback",
            },
        })
    return out


def asthma_encounter_dates(encounters, stats=None):
    """Every date carrying an asthma-flagged encounter, ANY visit type.

    The attributing evidence for decision 5. Inpatient rows are included on
    purpose — decision 2 excludes them from step-therapy DECISION POINTS, but a
    steroid course written at discharge from an asthma admission is plainly an
    asthma course.

    Not windowed: a fill just inside the window can legitimately be attributed
    to an asthma visit days before it opened, and the window is applied to the
    emitted anchors, not to the evidence.
    """
    if stats is None:
        stats = {}
    out = set()
    for r in encounters:
        if not r.get("asthma_related", False):
            continue
        d = parse_date(r.get("start_date"))
        if d is None:
            stats["skipped"] = stats.get("skipped", 0) + 1
            continue
        out.add(d)
    return out


def _attributable_to_asthma(d, asthma_dates):
    """Is an OCS fill on date `d` attributable to asthma? (decision 5)

    True when an asthma-flagged encounter falls within
    OCS_ASTHMA_ATTRIBUTION_DAYS either side.

    `asthma_dates` of None means "attribution not available" and everything
    passes — the pre-decision-5 behaviour, kept for the callers (and tests)
    that legitimately have no encounter table. A patient WITH an encounter
    table but no asthma-flagged encounter yields an empty set, which correctly
    attributes nothing: they had no asthma care to attribute a course to.
    """
    if asthma_dates is None:
        return True
    return any(abs((d - a).days) <= OCS_ASTHMA_ATTRIBUTION_DAYS for a in asthma_dates)


def _ocs_fill_dates(drugs, stats, asthma_dates=None):
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
            if not _attributable_to_asthma(d, asthma_dates):
                stats["ocs_not_asthma"] = stats.get("ocs_not_asthma", 0) + 1
                continue
            fills.append((d, row_id))
    fills.sort(key=lambda x: (x[0], str(x[1])))
    return fills


def _separate(dated_refs, sep_days=BURST_SEPARATION_DAYS):
    """Apply N-day event separation to a sorted [(date, ref)] list.

    A new event starts only when its date is more than `sep_days` after the
    previous COUNTED event's start — markers within the separation window are
    the same prolonged course, not a new event (mirrors etl.py's v0.5 rule,
    which cites the Blake RCT definition).
    """
    events, last_start = [], None
    for d, ref in dated_refs:
        if last_start is None or (d - last_start).days > sep_days:
            events.append((d, ref))
            last_start = d
    return events


def ocs_burst_anchors(drugs, win, stats=None, asthma_dates=None):
    """OCS burst starts with 14-day event separation, within the window.

    Deliberately OCS-fill-only: the follow-up rule anchors on this list, and
    an asthma ED visit already generates its own asthma_encounters anchor on
    the same day, so folding ED visits in here would ask the follow-up
    question twice for one event. The broader exacerbation set (which does
    fold them in) is `exacerbation_anchors`, used only to establish the
    controller obligation.
    """
    if stats is None:
        stats = {}
    fills = _ocs_fill_dates(drugs, stats, asthma_dates)
    bursts = []
    for d, row_id in _separate(fills):
        if not _in_window(d, win):
            stats["out_of_window"] = stats.get("out_of_window", 0) + 1
            continue
        bursts.append({"date": d.isoformat(), "ref": f"drugs:{row_id}"})
    return bursts


def exacerbation_anchors(drugs, encounters, win, stats=None, asthma_dates=None):
    """Exacerbations: OCS course, asthma ED visit, or asthma admission.

    This is etl.py's `exac` definition and both study documents' wording
    (decision 3 in the module docstring), with the same 14-day separation.

    Separation is applied over the patient's FULL history, then the emitted
    list is restricted to the window. Doing it in that order matters: a
    course three weeks before the window opens must still suppress a
    same-course fill just inside it, and it lets obligation_point_anchors see
    a pre-window first exacerbation when deciding whether an in-window one is
    the second within a rolling year.
    """
    if stats is None:
        stats = {}
    marks = [(d, f"drugs:{ref}") for d, ref in _ocs_fill_dates(drugs, stats, asthma_dates)]
    for r in encounters:
        if not r.get("asthma_related", False):
            continue
        typ = r.get("type") or ""
        if not (_is_ed(r, typ) or "Inpatient" in typ):
            continue
        d = parse_date(r.get("start_date"))
        if d is None:
            stats["skipped"] = stats.get("skipped", 0) + 1
            continue
        marks.append((d, f"encounters:{r.get('row_id')}"))
    marks.sort(key=lambda x: (x[0], str(x[1])))
    out = []
    for d, ref in _separate(marks):
        out.append({"date": d.isoformat(), "ref": ref, "_in_window": _in_window(d, win)})
    return out


def obligation_point_anchors(exacerbations, encounter_anchors, win):
    """The 2nd exacerbation within a rolling year establishes the obligation.

    EPR-3's severity tables (printed p.96 for ages 5-11, p.97 for 12+) state
    that patients with ">= 2 exacerbations requiring oral systemic
    corticosteroids IN THE PAST YEAR may be considered the same as patients
    who have persistent asthma", and persistent asthma requires a daily
    controller (Component 4, p.213, Evidence A). "In the past year" is why
    this is a rolling 365-day test rather than "the 2nd ever": under the
    latter, patients whose two courses were 506 to 2023 days apart were being
    treated as persistent.

    The point emitted is the FIRST IN-WINDOW exacerbation that is a second
    within a rolling year; exacerbations from before the window count toward
    the pair but are never themselves emitted. Scanning for the first
    in-window one (rather than the first over all history, then testing it
    for membership) matters: a patient who first became obliged years ago and
    has exacerbated twice again inside this window is still owed a controller
    during the window under audit, and the earlier reading dropped exactly
    those patients — it cut the obliged set from 25 patients to 5.

    Only one point per patient is emitted: the obligation, once established
    within the window, is not re-established by later exacerbations.

    `meta.deadline` is the date by which a controller must be active: the
    next asthma visit AFTER the obligation date. A visit on the obligation
    date itself is an opportunity, not the deadline. When no later visit is
    observed, the deadline is censored at index_date and flagged, so the
    downstream rule can distinguish "no controller by the deadline" from
    "the grace period ran past the end of observation".
    """
    if win is None:
        return []
    dates = [parse_date(e["date"]) for e in exacerbations]
    point = None
    for i, d in enumerate(dates):
        if not exacerbations[i].get("_in_window"):
            continue
        if any((d - prior).days <= OBLIGATION_LOOKBACK_DAYS for prior in dates[:i]):
            point = exacerbations[i]
            break
    if point is None:
        return []
    obligation_date = parse_date(point["date"])
    later = [parse_date(a["date"]) for a in encounter_anchors
             if parse_date(a["date"]) > obligation_date]
    censored = not later
    deadline = min(later) if later else win[1]
    return [{
        "date": point["date"],
        "ref": point["ref"],
        "meta": {
            "deadline": deadline.isoformat(),
            "deadline_censored": censored,
        },
    }]


def _read_json(path):
    if not os.path.exists(path):
        return None
    with open(path) as f:
        try:
            return json.load(f)
        except json.JSONDecodeError as e:
            raise ValueError(f"malformed JSON in {path}: {e}") from e


def resolve_index_date(patient_dir, omop_dir, pid):
    """The patient's index_date, from demographics.json or meta.json.

    ETL-produced patients carry it in demographics.json as a single-row list;
    hand-authored fixtures carry it in meta.json and write demographics as a
    bare dict. Both shapes are accepted so a fixture cannot silently end up
    with no window (which is what an unwindowed anchor list would mean).
    Returns None when neither source has a parseable date.
    """
    demo = _read_json(os.path.join(omop_dir, "demographics.json"))
    if isinstance(demo, dict):
        demo = [demo]
    if isinstance(demo, list):
        for row in demo:
            if isinstance(row, dict):
                d = parse_date(row.get("index_date"))
                if d is not None:
                    return d
    meta = _read_json(os.path.join(patient_dir, "meta.json"))
    if isinstance(meta, dict):
        return parse_date(meta.get("index_date"))
    return None


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

    index_date = resolve_index_date(patient_dir, omop_dir, pid)
    win = window_for(index_date)
    if win is None:
        raise ValueError(
            "no parseable index_date in demographics.json — refusing to emit "
            "anchors, because an unwindowed list silently reintroduces the "
            "whole-history denominator this script exists to bound")

    stats = {"skipped": 0, "out_of_window": 0, "ocs_not_asthma": 0}
    enc_anchors = asthma_encounter_anchors(encounters, win, stats)
    # Attributing evidence for decision 5. None (not an empty set) when the
    # patient has no encounter table at all — there is nothing to attribute
    # AGAINST, so refusing every course would be an artefact of a missing file
    # rather than a finding about the patient.
    asthma_dates = asthma_encounter_dates(encounters) if encounters else None
    bursts = ocs_burst_anchors(drugs, win, stats, asthma_dates)
    exacerbations = exacerbation_anchors(drugs, encounters, win, stats, asthma_dates)
    obligation = obligation_point_anchors(exacerbations, enc_anchors, win)
    # `_in_window` is scratch state for the obligation computation, not part
    # of the on-disk event-identity contract.
    exac_out = [{k: v for k, v in e.items() if k != "_in_window"}
                for e in exacerbations if e.get("_in_window")]

    adir = os.path.join(patient_dir, "anchors")
    os.makedirs(adir, exist_ok=True)
    counts = {"skipped": stats["skipped"], "out_of_window": stats["out_of_window"],
              "ocs_not_asthma": stats.get("ocs_not_asthma", 0)}
    for name, rows in (("asthma_encounters", enc_anchors),
                       ("ocs_bursts", bursts),
                       ("exacerbations", exac_out),
                       ("obligation_points", obligation)):
        with open(os.path.join(adir, f"{name}.json"), "w") as f:
            json.dump(rows, f, indent=1)
            f.write("\n")
        counts[name] = len(rows)
    return counts


def main():
    ap = argparse.ArgumentParser(
        description="Derive adherence event-anchor lists (asthma_encounters, "
                     "ocs_bursts, exacerbations, obligation_points) from each "
                     "matching patient's local OMOP JSON under --corpus. Every "
                     "list is bounded to the 12 months ending on index_date.")
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
        sfx = ""
        if counts.get("skipped"):
            sfx += f" skipped={counts['skipped']}"
        if counts.get("out_of_window"):
            sfx += f" out_of_window={counts['out_of_window']}"
        print(f"[anchors] {pid}: encounters={counts['asthma_encounters']} "
              f"bursts={counts['ocs_bursts']} exacerbations={counts['exacerbations']} "
              f"obligation={counts['obligation_points']}{sfx}")
        n += 1
    if n == 0:
        print(f"[anchors] WARNING: 0 patients matched --prefix {a.prefix!r} under {a.corpus!r}", file=sys.stderr)
        sys.exit(1)
    suffix = f" ({errors} error(s))" if errors else ""
    print(f"[anchors] wrote anchors for {n} patients{suffix}")


if __name__ == "__main__":
    main()
