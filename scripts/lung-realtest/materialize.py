#!/usr/bin/env python3
"""Materialize ONE real lung-cancer-experiment patient into the concur corpus as
a PHI patient (gitignored, meta.phi=true → routes to the Azure HIPAA model).

Reads the experiment's per-note .html (note text lives in a <pre> block),
extracts + unescapes the text, and writes platform-convention .txt notes plus
meta.json. Prints ONLY counts/filenames — never note content (PHI minimal
exposure).

Usage: python3 materialize.py <source_patient_id> <target_patient_id>
"""
import html
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]            # .../Chart-Review-Agents-main (monorepo root)
SRC_ROOT = REPO / "lung-cancer-experiment" / "benchmark_all_patients" / "notes"
DST_ROOT = REPO / "chart-review-platform-concur" / "corpus" / "patients"

_PRE = re.compile(r"<pre[^>]*>(.*?)</pre>", re.S | re.I)


def note_text(html_path: Path) -> str:
    raw = html_path.read_text(encoding="utf-8", errors="replace")
    m = _PRE.search(raw)
    inner = m.group(1) if m else re.sub(r"<[^>]+>", "", raw)
    return html.unescape(inner).strip()


def out_name(html_name: str) -> str:
    # "2015-02-16_PROGRESS_NOTE.txt_4965312663.html" -> "2015-02-16__progress_note.txt"
    date = html_name[:10]
    mid = html_name[11:]
    typ = mid.split(".txt", 1)[0].lower().strip("_") or "note"
    return f"{date}__{typ}.txt"


def main() -> None:
    src_id, dst_id = sys.argv[1], sys.argv[2]
    src = SRC_ROOT / src_id
    if not src.is_dir():
        sys.exit(f"source patient not found: {src}")
    dst = DST_ROOT / dst_id
    notes_dir = dst / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)

    dates, doctypes, n, total = [], set(), 0, 0
    for hp in sorted(src.glob("*.html")):
        txt = note_text(hp)
        if not txt:
            continue
        name = out_name(hp.name)
        (notes_dir / name).write_text(txt, encoding="utf-8")
        n += 1
        total += len(txt)
        dates.append(name[:10])
        doctypes.add(name.split("__", 1)[1].replace(".txt", ""))

    meta = {
        "patient_id": dst_id,
        "phi": True,
        "category": "lung_real",
        "index_date": min(dates) if dates else None,
        "doc_types": sorted(doctypes),
        "source": f"lung-cancer-experiment/{src_id}",
        "fixture_notes": "Real lung patient (PHI, gitignored). Wired for lung-cancer-adherence "
                         "cost testing; meta.phi=true routes it to the Azure HIPAA model.",
    }
    (dst / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    # counts ONLY — no PHI content
    print(f"materialized {dst_id}: {n} notes, {total} chars, "
          f"dates {meta['index_date']}..{max(dates) if dates else '-'}, "
          f"doctypes={sorted(doctypes)}")


if __name__ == "__main__":
    main()
