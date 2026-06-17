#!/usr/bin/env python3
"""Build gitignored concur fixtures for the adjudicated RUCAM validation set.

Default: builds ALL adjudicated cases that have cohort data + notes as
patient_phi_001..00N (sorted by gold total, descending). --one builds just the
top case (for a quick single-patient run).

For each: corpus/patients/patient_phi_00K/{meta.json, notes/, expected_rucam.json}.
expected_rucam.json carries the full human gold: total, category, and per-item
scores (parsed from the FINAL RUCAM SCORE block, reconciled against the
annotation block + the total).

PHI discipline: reads real data and copies note files but prints only
NON-identifying summary (per-fixture note count + gold total/category). Never
prints person_id or clinical text. Fixtures match the gitignored patient_phi_*
pattern; the real person_id lives only in the (ignored) meta.json.

Usage (from concur root):
  ./python/.venv/bin/python scripts/rucam-realtest/setup.py \
      --data-dir ../RUCAM/data_v3 --adj ../RUCAM/Validation_Adjudication_v3.xlsx
"""
import argparse, json, re, shutil, sys
from pathlib import Path
import pandas as pd

ITEM_LABELS = {
    1: ["time to onset"], 2: ["course"], 3: ["risk factor"],
    4: ["concomitant"], 5: ["alternative", "exclusion", "other cause"],
    6: ["hepatotox", "prior hepato"], 7: ["rechallenge"],
}


def rucam_category(total):
    if total is None: return "(n/a)"
    if total >= 9: return "highly_probable"
    if total >= 6: return "probable"
    if total >= 3: return "possible"
    if total >= 1: return "unlikely"
    return "excluded"


def _ints(cells):
    out = []
    for c in cells:
        try:
            out.append(int(float(str(c).strip())))
        except (ValueError, TypeError):
            pass
    return out


def parse_sheet(df):
    """Return {'pid','total','category','items':{1..7:int|None},'complete':bool}."""
    rows = [[("" if pd.isna(c) else str(c).strip()) for c in r] for r in df.values]

    pid = None
    for r in rows[:8]:
        for c in r:
            if c.isdigit() and len(c) >= 12:
                pid = int(c); break
        if pid is not None: break

    # annotation block: rows labeled "N <name>"
    ann = {}
    for r in rows:
        for c in r:
            m = re.match(r"^([1-7])\s+\D", c)
            if m:
                vs = _ints(r)
                if vs:
                    ann[int(m.group(1))] = vs[-1]
                break

    # final block: positional 7 numeric rows between "FINAL RUCAM SCORE" and "Total Score"
    fin = {}
    total = None
    fstart = next((i for i, r in enumerate(rows)
                   if any("final rucam score" in c.lower() for c in r)), None)
    if fstart is not None:
        seq = []
        for r in rows[fstart + 1:]:
            low = " ".join(r).lower()
            if "total score" in low:
                vs = _ints(r)
                if vs:
                    total = vs[-1]
                break
            if any(h in low for h in ("item", "score", "annotator")) and not _ints(r):
                continue  # header row
            vs = _ints(r)
            if vs:
                seq.append(vs[-1])
        if len(seq) >= 7:
            fin = {i + 1: seq[i] for i in range(7)}
    if total is None:  # fallback: annotation "total:"
        for r in rows:
            if any(c.lower() == "total:" for c in r):
                vs = _ints(r)
                if vs:
                    total = vs[-1]

    items = {i: (fin.get(i) if fin else ann.get(i)) for i in range(1, 8)}
    # if exactly one missing and total known, derive it
    missing = [i for i in range(1, 8) if items[i] is None]
    known_sum = sum(v for v in items.values() if v is not None)
    if len(missing) == 1 and total is not None:
        items[missing[0]] = total - known_sum
        missing = []
    complete = (not missing and total is not None
                and sum(items.values()) == total)

    return {"pid": pid, "total": total,
            "category": rucam_category(total), "items": items,
            "complete": complete}


def safe_name(name):
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")
    return base or "note"


def _cv(x):
    """JSON-safe cell value: NaN -> None, numpy scalar -> python."""
    if x is None or (isinstance(x, float) and pd.isna(x)):
        return None
    return x.item() if hasattr(x, "item") else x


def materialize_omop(fixture, pid, data_dir):
    """Write the patient's cohort rows into omop/<table>.json so concur's
    structured-data surface (readStructured / read_structured_data / the UI) can
    show the labs, meds, serology, and conditions the agent scored from — which
    otherwise live only in the out-of-band plugin cohort CSVs and are invisible to
    a reviewer. row_ids are deterministic per table (citable later). Returns
    {table: n_rows}."""
    omop = fixture / "omop"
    omop.mkdir(exist_ok=True)

    def _load(name):
        p = data_dir / name
        if not p.exists():
            return None
        df = pd.read_csv(p)
        return df[df["PERSON_ID"] == pid]

    meas, rid = [], 100000
    lft = _load("lft_series.csv")
    if lft is not None:
        for _, r in lft.iterrows():
            meas.append({"row_id": rid, "concept_name": _cv(r.get("LAB_NAME")),
                         "value": _cv(r.get("VALUE_AS_NUMBER")), "uln": _cv(r.get("ULN")),
                         "date": str(r.get("MEASUREMENT_DATE", "")),
                         "days_from_injury": _cv(r.get("DAYS_FROM_LIVER_INJURY"))}); rid += 1
    sero = _load("serology.csv")
    if sero is not None:
        for _, r in sero.iterrows():
            meas.append({"row_id": rid, "concept_name": _cv(r.get("LAB_NAME")),
                         "value": _cv(r.get("VALUE_AS_NUMBER")), "value_text": _cv(r.get("VALUE_SOURCE_VALUE")),
                         "date": str(r.get("MEASUREMENT_DATE", "")),
                         "days_from_injury": _cv(r.get("DAYS_FROM_LIVER_INJURY"))}); rid += 1
    (omop / "measurements.json").write_text(json.dumps(meas, indent=0, allow_nan=False))

    meds, rid = [], 200000
    am = _load("all_meds.csv")
    if am is not None:
        for _, r in am.iterrows():
            meds.append({"row_id": rid, "concept_name": _cv(r.get("DRUG_NAME")),
                         "start_date": str(r.get("START_DATE", "")), "end_date": str(r.get("STOP_DATE", "")),
                         "active_at_injury": _cv(r.get("ACTIVE_AT_LIVER_INJURY")),
                         "days_from_injury_start": _cv(r.get("DAYS_FROM_LIVER_INJURY_START"))}); rid += 1
    (omop / "drugs.json").write_text(json.dumps(meds, indent=0, allow_nan=False))

    cond, rid = [], 300000
    cd = _load("conditions.csv")
    if cd is not None:
        for _, r in cd.iterrows():
            cond.append({"row_id": rid, "concept_name": _cv(r.get("CONDITION")),
                         "icd10cm": str(r.get("ICD9_10", "")), "date": str(r.get("DIAG_DATE", "")),
                         "days_from_injury": _cv(r.get("DAYS_FROM_LIVER_INJURY"))}); rid += 1
    (omop / "conditions.json").write_text(json.dumps(cond, indent=0, allow_nan=False))

    return {"measurements": len(meas), "drugs": len(meds), "conditions": len(cond)}


def build_fixture(fid, pid, gold, data_dir, corpus, note_window):
    derived = pd.read_csv(data_dir / "derived_rucam.csv")
    liver_date = str(derived.loc[derived["PERSON_ID"] == pid, "liver_injury_date"].iloc[0])
    fixture = corpus / fid
    if fixture.exists():
        shutil.rmtree(fixture)
    (fixture / "notes").mkdir(parents=True)

    copied = 0
    for src in sorted((data_dir / "notes" / str(pid)).glob("*.txt")):
        if note_window is not None:
            day = None
            for line in src.read_text(encoding="utf-8", errors="replace").splitlines()[:6]:
                if line.lower().startswith("date:"):
                    d = pd.to_datetime(line.split(":", 1)[1].strip(), errors="coerce")
                    li = pd.to_datetime(liver_date, errors="coerce")
                    if pd.notna(d) and pd.notna(li):
                        day = (d - li).days
            if day is not None and abs(day) > note_window:
                continue
        shutil.copy2(src, fixture / "notes" / safe_name(src.name))
        copied += 1

    (fixture / "meta.json").write_text(json.dumps({
        "patient_id": fid, "category": "rucam_realtest", "person_id": int(pid),
        "phi": True, "index_date": liver_date[:10],
        "generated_by": "REAL RUCAM patient (PHI) — local Azure validation only; gitignored",
    }, indent=2) + "\n")
    (fixture / "expected_rucam.json").write_text(json.dumps({
        "person_id": int(pid), "gold_total": gold["total"],
        "gold_category": gold["category"], "gold_items": gold["items"],
        "gold_complete": gold["complete"],
        "source": "Validation_Adjudication_v3.xlsx (human annotator)",
    }, indent=2) + "\n")
    omop_counts = materialize_omop(fixture, pid, data_dir)
    return copied, omop_counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--adj", required=True)
    ap.add_argument("--corpus", default="corpus/patients")
    ap.add_argument("--note-window", type=int, default=None)
    ap.add_argument("--one", action="store_true", help="build only the top case")
    args = ap.parse_args()

    data_dir = Path(args.data_dir).resolve()
    corpus = Path(args.corpus)
    derived = pd.read_csv(data_dir / "derived_rucam.csv")
    cohort = set(derived["PERSON_ID"].astype("int64").tolist())
    notes_root = data_dir / "notes"

    xl = pd.ExcelFile(Path(args.adj).resolve())
    cands = []
    for sheet in xl.sheet_names:
        g = parse_sheet(pd.read_excel(xl, sheet, header=None))
        pid = g["pid"]
        if pid is None or pid not in cohort:
            continue
        nd = notes_root / str(pid)
        if not nd.is_dir() or not any(nd.glob("*.txt")):
            continue
        if g["total"] is None:
            continue
        cands.append(g)
    if not cands:
        sys.exit("no adjudicated patient has cohort data + notes")

    cands.sort(key=lambda g: (-g["total"], g["pid"]))
    if args.one:
        cands = cands[:1]

    # clear stale fixtures
    for d in corpus.glob("patient_phi_*"):
        shutil.rmtree(d)

    print(f"[setup] building {len(cands)} fixture(s) from {data_dir.name}")
    for k, g in enumerate(cands, 1):
        fid = f"patient_phi_{k:03d}"
        n, omop = build_fixture(fid, g["pid"], g, data_dir, corpus, args.note_window)
        flag = "" if g["complete"] else "  (gold per-item incomplete — total reliable)"
        print(f"[setup]   {fid}: notes={n:>3}  omop(meas/drug/cond)="
              f"{omop['measurements']}/{omop['drugs']}/{omop['conditions']}  gold_total={g['total']:>3}  "
              f"category={g['category']:<16} items={[g['items'][i] for i in range(1,8)]}{flag}")
    print(f"[setup] fixtures under {corpus}/patient_phi_*  (gitignored)")


if __name__ == "__main__":
    main()
