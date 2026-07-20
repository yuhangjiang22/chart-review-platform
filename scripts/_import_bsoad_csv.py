#!/usr/bin/env python3
"""Convert acts/bso_ad_sample.csv (PHI) → ACTS corpus patients (one per person_id).
PHI-SAFE stdout: prints only counts + the assigned patient_ids (no person_id, no note text).
Patients are patient_real_acts_NNN (gitignored via patient_real_*; phi:true → Azure routing).
"""
import csv, json, re, pathlib, collections

ROOT = pathlib.Path(__file__).resolve().parents[1]          # concur root
CSV = ROOT.parent / "acts" / "bso_ad_sample.csv"            # sibling acts repo
CORPUS = ROOT / "corpus" / "patients"

def slug(s, n=48):
    return re.sub(r"_+", "_", re.sub(r"[^A-Za-z0-9]+", "_", s)).strip("_")[:n] or "note"

rows = list(csv.DictReader(open(CSV, newline="", encoding="utf-8", errors="replace")))
by_pid = collections.OrderedDict()
for r in rows:
    by_pid.setdefault(r["person_id"], []).append(r)

# deterministic: sort person_ids, assign 001..NNN
pids = sorted(by_pid)
created = []
for i, pid in enumerate(pids, 1):
    name = f"patient_real_acts_{i:03d}"
    pdir = CORPUS / name
    ndir = pdir / "notes"
    ndir.mkdir(parents=True, exist_ok=True)
    notes = sorted(by_pid[pid], key=lambda r: (r["report_time"], r["row_id"]))
    doc_types = sorted({n["report_type"] for n in notes})
    seen = set()
    for n in notes:
        date = (n["report_time"] or "")[:10] or "undated"
        base = f"{date}__{slug(n['report_type'])}__{n['row_id']}"
        fn = base
        k = 1
        while fn in seen:
            fn = f"{base}_{k}"; k += 1
        seen.add(fn)
        (ndir / f"{fn}.txt").write_text(n["note_text"], encoding="utf-8")
    meta = {
        "patient_id": name,
        "category": "bso_ad_sample",
        "phi": True,                       # → Azure routing + gitignored
        "person_id": pid,                  # traceability (stays in gitignored dir)
        "doc_types": doc_types,
        "n_notes": len(notes),
        "generated_by": "bso_ad_sample.csv import",
    }
    (pdir / "meta.json").write_text(json.dumps(meta, indent=2))
    created.append((name, len(notes)))

print(f"created {len(created)} patients from {len(rows)} notes")
multi = sorted([c for c in created if c[1] > 1], key=lambda x: -x[1])
print(f"patients with >1 note: {len(multi)}  (good for per-note testing)")
print("top multi-note patients (id, #notes):", multi[:5])
