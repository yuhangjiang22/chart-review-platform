import ast
import re
from pathlib import Path
from typing import Dict, List, Optional, Union

import pandas as pd

# Section header pattern: short line that is ALL-CAPS or Title Case ending with ":"
_SECTION_RE = re.compile(
    r"^(?:[A-Z][A-Z0-9 /&\-]{2,}:?$|[A-Z][a-zA-Z0-9 /&\-]{2,}:)\s*$"
)

_MASTERLIST_PATH = Path(__file__).parent.parent / "masterlist02-26.xlsx"
_MASTERLIST_CACHE: Optional[pd.DataFrame] = None
_CATEGORY_SCORE = {"A": 2, "B": 1, "C": 0, "D": 0, "E": 0}


def _load(data_dir: str, filename: str) -> pd.DataFrame:
    path = Path(data_dir) / filename
    if not path.exists():
        raise FileNotFoundError(f"Required data file not found: {path}")
    return pd.read_csv(path)


def get_patient_summary(person_id: int, data_dir: str = "data") -> dict:
    """Return pre-computed RUCAM features for a patient from derived_rucam.csv.
    Includes serology result columns (HAV_IgM_result, HBsAg_result, etc.) which
    are now populated with qualitative results (e.g. 'Positive', 'Negative', None)."""
    df = _load(data_dir, "derived_rucam.csv")
    rows = df[df["PERSON_ID"] == person_id]
    if rows.empty:
        return {"result": [], "message": f"No data found for person_id={person_id}"}
    return rows.iloc[0].to_dict()


def get_suspect_drug(person_id: int, data_dir: str = "data") -> dict:
    """Return the selected suspect drug for a patient from chart_review.csv.
    Returns no-data message if patient is not present (e.g. no_dili_drug_records stratum)."""
    df = _load(data_dir, "chart_review.csv")
    rows = df[df["PERSON_ID"] == person_id]
    if rows.empty:
        return {"result": [], "message": f"No data found for person_id={person_id}"}
    return rows.iloc[0].to_dict()


def get_medications(
    person_id: int,
    data_dir: str = "data",
    drug_name: Optional[str] = None,
    in_90day_window: Optional[bool] = None,
    active_at_liver_injury: Optional[bool] = None,
) -> Union[List[Dict], Dict]:
    """Return medications for a patient from all_meds.csv.
    Key columns: DRUG_CODE, DRUG_NAME, DRUG_TYPE, START_DATE, STOP_DATE,
    DAYS_SUPPLY_VAL, DAYS_FROM_LIVER_INJURY_START, DAYS_FROM_LIVER_INJURY_STOP,
    ACTIVE_AT_LIVER_INJURY, IN_90DAY_WINDOW.
    If STOP_DATE is null, compute end_date = START_DATE + DAYS_SUPPLY_VAL days.
    drug_name: case-insensitive literal substring match on DRUG_NAME — optional
    convenience filter; works for simple names. For complex/combination drug names
    (e.g. "Sulfamethoxazole/Trimethoprim"), call without filter and match manually.
    Optional filters: in_90day_window=True keeps IN_90DAY_WINDOW==1;
    active_at_liver_injury=True keeps ACTIVE_AT_LIVER_INJURY==1."""
    df = _load(data_dir, "all_meds.csv")
    df = df[df["PERSON_ID"] == person_id]
    if df.empty:
        return {"result": [], "message": f"No medications found for person_id={person_id}"}
    if drug_name:
        df = df[df["DRUG_NAME"].str.contains(drug_name, case=False, na=False, regex=False)]
    if in_90day_window:
        df = df[df["IN_90DAY_WINDOW"] == 1]
    if active_at_liver_injury:
        df = df[df["ACTIVE_AT_LIVER_INJURY"] == 1]
    if df.empty:
        filters = []
        if drug_name:
            filters.append(f"drug_name={drug_name!r}")
        if in_90day_window:
            filters.append("in_90day_window=True")
        if active_at_liver_injury:
            filters.append("active_at_liver_injury=True")
        return {"result": [], "message": f"No medications match filter ({', '.join(filters)}) for person_id={person_id}"}
    drop_cols = [c for c in ["PERSON_ID", "STRATUM", "liver_injury_date"] if c in df.columns]
    return df.drop(columns=drop_cols).to_dict(orient="records")


def get_drug_episodes(
    person_id: int,
    data_dir: str = "data",
    drug_name: Optional[str] = None,
    drug_code: Optional[str] = None,
) -> Union[List[Dict], Dict]:
    """Return merged drug exposure episodes for a patient, applying the 45-day gap rule.

    Fills are matched by DRUG_NAME (case-insensitive substring) and/or DRUG_CODE (exact).
    At least one of drug_name or drug_code must be provided.

    For each matched fill: end_date = STOP_DATE if present, else START_DATE + DAYS_SUPPLY_VAL.
    Fills sorted by START_DATE. Consecutive fills with gap ≤ 45 days (from prior end_date
    to next START_DATE) are merged into one continuous episode (initial treatment).
    Gaps > 45 days start a new episode (re-exposure).

    Each episode: {start_date, end_date, start_day, end_day, n_fills, relative_to_t0}
    where *_day is DAYS_FROM_LIVER_INJURY (negative = before T0), and relative_to_t0 is
    one of: 'ongoing_at_t0' (start ≤ 0 ≤ end), 'stopped_before' (end < 0),
    'started_after' (start > 0).
    """
    if drug_name is None and drug_code is None:
        return {"result": [], "message": "Provide drug_name and/or drug_code"}

    df = _load(data_dir, "all_meds.csv")
    df = df[df["PERSON_ID"] == person_id]
    if df.empty:
        return {"result": [], "message": f"No medications found for person_id={person_id}"}

    # Liver injury date for day offsets
    liver_injury_date = pd.to_datetime(df["liver_injury_date"].iloc[0])

    mask = pd.Series(False, index=df.index)
    if drug_name:
        for comp in [c.strip() for c in drug_name.split("/") if c.strip()]:
            mask |= df["DRUG_NAME"].astype(str).str.contains(comp, case=False, na=False, regex=False)
    if drug_code:
        mask |= df["DRUG_CODE"].astype(str) == str(drug_code)
    df = df[mask]
    if df.empty:
        return {"result": [], "message": f"No fills match drug_name={drug_name!r} drug_code={drug_code!r} for person_id={person_id}"}

    fills = []
    for _, r in df.iterrows():
        start = pd.to_datetime(r["START_DATE"], errors="coerce")
        stop = pd.to_datetime(r.get("STOP_DATE"), errors="coerce")
        if pd.isna(stop):
            days_supply = r.get("DAYS_SUPPLY_VAL")
            if pd.notna(days_supply) and pd.notna(start):
                stop = start + pd.Timedelta(days=int(days_supply))
        if pd.isna(start) or pd.isna(stop):
            continue
        fills.append({"start": start, "end": stop, "drug_name": r["DRUG_NAME"]})

    if not fills:
        return {"result": [], "message": f"Matched fills have no usable start/stop dates"}

    fills.sort(key=lambda f: f["start"])

    episodes = []
    cur_start = fills[0]["start"]
    cur_end = fills[0]["end"]
    cur_n = 1
    for f in fills[1:]:
        gap_days = (f["start"] - cur_end).days
        if gap_days <= 45:
            cur_end = max(cur_end, f["end"])
            cur_n += 1
        else:
            episodes.append((cur_start, cur_end, cur_n))
            cur_start, cur_end, cur_n = f["start"], f["end"], 1
    episodes.append((cur_start, cur_end, cur_n))

    out = []
    for start, end, n in episodes:
        start_day = (start - liver_injury_date).days
        end_day = (end - liver_injury_date).days
        if start_day <= 0 <= end_day:
            rel = "ongoing_at_t0"
        elif end_day < 0:
            rel = "stopped_before"
        else:
            rel = "started_after"
        out.append({
            "start_date": start.strftime("%Y-%m-%d"),
            "end_date": end.strftime("%Y-%m-%d"),
            "start_day": int(start_day),
            "end_day": int(end_day),
            "n_fills": n,
            "relative_to_t0": rel,
        })
    return out


def get_lft_series(
    person_id: int,
    data_dir: str = "data",
    lab_name: Optional[str] = None,
    day_min: Optional[int] = None,
    day_max: Optional[int] = None,
) -> Union[List[Dict], Dict]:
    """Return liver function test time series for a patient from lft_series.csv.
    Key columns: LAB_NAME, VALUE_AS_NUMBER, ULN, MEASUREMENT_DATE, DAYS_FROM_LIVER_INJURY.
    Optional filters: lab_name matches LAB_NAME; day_min/day_max filter DAYS_FROM_LIVER_INJURY."""
    df = _load(data_dir, "lft_series.csv")
    df = df[df["PERSON_ID"] == person_id]
    if lab_name:
        df = df[df["LAB_NAME"] == lab_name]
    if day_min is not None:
        df = df[df["DAYS_FROM_LIVER_INJURY"] >= day_min]
    if day_max is not None:
        df = df[df["DAYS_FROM_LIVER_INJURY"] <= day_max]
    if df.empty:
        return {"result": [], "message": f"No data found for person_id={person_id}"}
    return df.to_dict(orient="records")


def get_lab_extremum(
    person_id: int,
    lab_name: str,
    stat: str,
    data_dir: str = "data",
    day_min: Optional[int] = None,
    day_max: Optional[int] = None,
) -> dict:
    """Return the min or max value of a lab within [day_min, day_max] (inclusive).
    Useful for computing dechallenge nadir (min) or injury peak (max) without scanning
    the full series manually.

    Args:
        lab_name: e.g. 'ALT', 'ALP', 'bilirubin_total', 'AST'
        stat: 'min' or 'max'
        day_min, day_max: filter on DAYS_FROM_LIVER_INJURY (inclusive). If both None,
            scans the full series.

    Returns: {'value': float, 'date': str, 'day': int, 'uln': float or None} or
             {'result': [], 'message': '...'} if no rows match.
    """
    if stat not in ("min", "max"):
        return {"result": [], "message": f"stat must be 'min' or 'max', got {stat!r}"}
    df = _load(data_dir, "lft_series.csv")
    df = df[(df["PERSON_ID"] == person_id) & (df["LAB_NAME"] == lab_name)]
    if day_min is not None:
        df = df[df["DAYS_FROM_LIVER_INJURY"] >= day_min]
    if day_max is not None:
        df = df[df["DAYS_FROM_LIVER_INJURY"] <= day_max]
    if df.empty:
        window = f"[{day_min}, {day_max}]" if (day_min is not None or day_max is not None) else "(full series)"
        return {"result": [], "message": f"No {lab_name} values for person_id={person_id} in window {window}"}
    idx = df["VALUE_AS_NUMBER"].idxmax() if stat == "max" else df["VALUE_AS_NUMBER"].idxmin()
    row = df.loc[idx]
    return {
        "value": float(row["VALUE_AS_NUMBER"]),
        "date": str(row.get("MEASUREMENT_DATE", "")),
        "day": int(row["DAYS_FROM_LIVER_INJURY"]),
        "uln": float(row["ULN"]) if pd.notna(row.get("ULN")) else None,
    }


def get_serology(
    person_id: int,
    data_dir: str = "data",
    lab_name: Optional[str] = None,
) -> Union[List[Dict], Dict]:
    """Return serology and viral lab results for a patient from serology.csv.
    Key columns: LAB_NAME, VALUE_AS_NUMBER, VALUE_SOURCE_VALUE (qualitative result),
    MEASUREMENT_DATE, DAYS_FROM_LIVER_INJURY.
    Optional filter: lab_name matches LAB_NAME (e.g. HAV_IgM, HBsAg, CMV_PCR)."""
    df = _load(data_dir, "serology.csv")
    df = df[df["PERSON_ID"] == person_id]
    if lab_name:
        df = df[df["LAB_NAME"] == lab_name]
    if df.empty:
        return {"result": [], "message": f"No data found for person_id={person_id}"}
    return df.to_dict(orient="records")


def get_conditions(person_id: int, data_dir: str = "data") -> Union[List[Dict], Dict]:
    """Return comorbidity diagnoses for a patient from conditions.csv.
    Columns: PERSON_ID, DIAG_DATE, ICD9_10 (list), DAYS_FROM_LIVER_INJURY,
    liver_injury_date, CONDITION.
    ICD9_10 is parsed from its string representation into a Python list."""
    df = _load(data_dir, "conditions.csv")
    df = df[df["PERSON_ID"] == person_id]
    if df.empty:
        return {"result": [], "message": f"No data found for person_id={person_id}"}
    records = df.to_dict(orient="records")
    for r in records:
        try:
            r["ICD9_10"] = ast.literal_eval(r["ICD9_10"])
        except (ValueError, SyntaxError):
            r["ICD9_10"] = [r["ICD9_10"]]
    return records


def list_notes_index(
    person_id: int,
    data_dir: str = "data",
    day_min: Optional[int] = None,
    day_max: Optional[int] = None,
) -> str:
    """List clinical notes for a patient as a compact table.
    Returns a plain-text table: DAYS, DATE, SERVICE, NOTE_ID, FILE_PATH.
    Pass FILE_PATH directly to read_file() to get the full note text.
    Notes sorted by DAYS_FROM_LIVER_INJURY (negative = before injury).
    Use day_min/day_max to filter by window (e.g. day_min=-90, day_max=180)."""
    notes_dir = Path(data_dir) / "notes" / str(person_id)
    if not notes_dir.exists():
        return f"No notes directory found for person_id={person_id}"

    derived = _load(data_dir, "derived_rucam.csv")
    row = derived[derived["PERSON_ID"] == person_id]
    if row.empty:
        return f"No patient record found for person_id={person_id}"
    liver_injury_date = pd.to_datetime(row.iloc[0]["liver_injury_date"])

    records = []
    for fpath in notes_dir.glob("*.txt"):
        lines = fpath.read_text(encoding="utf-8").splitlines()
        meta = {}
        for line in lines[:6]:
            if ":" in line:
                key, _, val = line.partition(":")
                meta[key.strip().upper()] = val.strip()
        # support both "DATE" and "ENCOUNTER ID" header variants
        date_str = meta.get("DATE", "")
        note_date = pd.to_datetime(date_str, errors="coerce")
        days = int((note_date - liver_injury_date).days) if not pd.isnull(note_date) else None
        if day_min is not None and (days is None or days < day_min):
            continue
        if day_max is not None and (days is None or days > day_max):
            continue
        note_id = meta.get("NOTE_ID", meta.get("ENCOUNTER ID", meta.get("MULTIMEDIA_CONTENT_ID", ""))).split(".")[0]
        records.append({
            "days": days,
            "date": date_str[:10],
            "service": meta.get("SERVICE", ""),
            "note_id": note_id,
            "file_path": f"/{data_dir}/notes/{person_id}/{fpath.name}",
        })

    if not records:
        window = ""
        if day_min is not None or day_max is not None:
            window = f" in window [{day_min}, {day_max}]"
        return f"No notes found for person_id={person_id}{window}"

    records.sort(key=lambda x: (x["days"] is None, x["days"]))

    header = f"{'DAYS':>6}  {'DATE':<10}  {'SERVICE':<40}  {'NOTE_ID':<15}  FILE_PATH"
    lines = [header, "-" * 120]
    for r in records:
        days_str = f"{r['days']:+d}" if r["days"] is not None else "  N/A"
        lines.append(f"{days_str:>6}  {r['date']:<10}  {r['service']:<40}  {r['note_id']:<15}  {r['file_path']}")
    return "\n".join(lines)


def search_notes(person_id: int, keyword: str, data_dir: str = "data") -> str:
    """Search for a keyword across all clinical notes for a patient.
    Returns matching lines with file path and line number. Case-insensitive.
    Use this to quickly find notes mentioning a drug name, lab value, or clinical term."""
    import re
    notes_dir = Path(data_dir) / "notes" / str(person_id)
    if not notes_dir.exists():
        return f"No notes directory found for person_id={person_id}"

    pattern = re.compile(re.escape(keyword), re.IGNORECASE)
    results = []
    for fpath in sorted(notes_dir.glob("*.txt")):
        rel_path = f"/{data_dir}/notes/{person_id}/{fpath.name}"
        for line_num, line in enumerate(fpath.read_text(encoding="utf-8").splitlines(), 1):
            if pattern.search(line):
                results.append(f"{rel_path}:{line_num} -- {line.strip()}")

    if not results:
        return f"No matches found for '{keyword}' in notes of person_id={person_id}."
    return "\n".join(results)


def get_note_section(
    file_path: str,
    sections: Optional[List[str]] = None,
    data_dir: str = "data",
) -> str:
    """Extract specific sections from a clinical note to save tokens.
    file_path: virtual path from list_notes_index (e.g. /data_v3/notes/PID/note.txt).
    sections: list of section names to extract (case-insensitive). Defaults to
    RUCAM-relevant sections: Assessment, Plan, Impression, Diagnoses, Hospital Course,
    Labs, Medications, History of Present Illness.
    Returns the header metadata + matching section content only.
    Use read_file(file_path) if you need the full note text."""
    default_sections = [
        "assessment", "plan", "impression", "diagnos", "hospital course",
        "labs", "laboratory", "medications", "history of present illness",
        "hpi", "discharge diagnosis", "final diagnosis", "problem list",
    ]
    targets = [s.lower() for s in (sections or default_sections)]

    os_path = Path(file_path.lstrip("/"))
    if not os_path.exists():
        return f"File not found: {file_path}"

    lines = os_path.read_text(encoding="utf-8").splitlines()

    # Always include the header (first 6 lines + separator)
    header_lines = lines[:7]

    # Parse note body into sections
    body = lines[7:]
    parsed: Dict[str, List[str]] = {}
    current_section = "_preamble"
    parsed[current_section] = []

    for line in body:
        stripped = line.strip()
        if stripped and _SECTION_RE.match(stripped) and len(stripped) < 80:
            current_section = stripped.rstrip(":")
            parsed.setdefault(current_section, [])
        else:
            parsed[current_section].append(line)

    # Collect matching sections
    matched = []
    for sec_name, sec_lines in parsed.items():
        if any(t in sec_name.lower() for t in targets):
            content = "\n".join(sec_lines).strip()
            if content:
                matched.append(f"[{sec_name}]\n{content}")

    if not matched:
        return "\n".join(header_lines) + "\n\n(No matching sections found — use read_file for full text)"

    return "\n".join(header_lines) + "\n\n" + "\n\n".join(matched)


def get_hepatotoxicity_category(drug_name: str) -> dict:
    """Look up LiverTox hepatotoxicity category for a drug from masterlist02-26.xlsx (1715 drugs).
    Returns: {drug, brand, category, score, chapter, matched_on} — or not-found message.
    Score mapping per RUCAM Item 6:
      Category A → +2 (well-known hepatotoxin, FDA-labeled)
      Category B → +1 (probable, published case reports, not on label)
      Category C/D/E/E* → 0
      Not found → 0 (score default, may be +1/+2 if external FDA label/literature evidence)
    Matches ingredient or brand name substring (case-insensitive). For combination/compound
    drug names, splits on '/', ',', and strips parentheses (e.g. 'Contraceptives (Levonorgestrel,
    Norethindrone)' → [Contraceptives, Levonorgestrel, Norethindrone]) and returns the
    highest-scoring component."""
    global _MASTERLIST_CACHE
    if _MASTERLIST_CACHE is None:
        df = pd.read_excel(_MASTERLIST_PATH, header=1)
        df.columns = ["count", "ingredient", "brand", "likelihood", "chapter",
                      "last_update", "year_approved", "in_livertox",
                      "primary_class", "secondary_class"]
        _MASTERLIST_CACHE = df
    df = _MASTERLIST_CACHE

    # Split on /, comma, parentheses, semicolons, 'and', '+' — handle compound drug names
    raw = re.split(r"[\/,;()+]|\band\b", drug_name, flags=re.IGNORECASE)
    components = [c.strip() for c in raw if c.strip() and len(c.strip()) >= 3]
    if not components:
        components = [drug_name]

    best = None
    for comp in components:
        matches = df[
            df["ingredient"].astype(str).str.contains(comp, case=False, na=False, regex=False)
            | df["brand"].astype(str).str.contains(comp, case=False, na=False, regex=False)
        ]
        for _, row in matches.iterrows():
            cat = str(row["likelihood"]).strip()
            score = _CATEGORY_SCORE.get(cat.rstrip("*").upper(), 0)
            if best is None or score > best["score"]:
                best = {
                    "drug": row["ingredient"],
                    "brand": row["brand"],
                    "category": cat,
                    "score": score,
                    "chapter": row["chapter"],
                    "matched_on": comp,
                }

    if best is None:
        return {
            "drug": drug_name,
            "category": "not listed",
            "score": 0,
            "message": f"'{drug_name}' not found in LiverTox masterlist. Default score = 0; use FDA label/published literature to justify +1/+2 if applicable.",
        }
    return best


def list_notes(person_id: int, data_dir: str = "data") -> Union[List[Dict], Dict]:
    """List available clinical notes for a patient from notes/{person_id}/ directory,
    sorted by DAYS_FROM_LIVER_INJURY.
    Returns: list of {note_id, PHYSIOLOGIC_TIME, DAYS_FROM_LIVER_INJURY, SERVICE_NAME}.
    Returns: list of {note_id, PHYSIOLOGIC_TIME, DAYS_FROM_LIVER_INJURY, SERVICE_NAME}."""
    notes_dir = Path(data_dir) / "notes" / str(person_id)
    if not notes_dir.exists():
        return {"result": [], "message": f"No notes found for person_id={person_id}"}

    # Get liver_injury_date from derived_rucam.csv to compute DAYS_FROM_LIVER_INJURY
    derived = _load(data_dir, "derived_rucam.csv")
    row = derived[derived["PERSON_ID"] == person_id]
    if row.empty:
        return {"result": [], "message": f"No patient record found for person_id={person_id}"}
    liver_injury_date = pd.to_datetime(row.iloc[0]["liver_injury_date"])

    records = []
    for fpath in notes_dir.glob("*.txt"):
        # Parse header lines
        lines = fpath.read_text(encoding="utf-8").splitlines()
        meta = {}
        for line in lines[:6]:
            if ":" in line:
                key, _, val = line.partition(":")
                meta[key.strip()] = val.strip()
        note_date = pd.to_datetime(meta.get("DATE", ""), errors="coerce")
        days = int((note_date - liver_injury_date).days) if not pd.isnull(note_date) else None
        records.append({
            "note_id": meta.get("NOTE_ID", fpath.stem),
            "PHYSIOLOGIC_TIME": meta.get("DATE"),
            "DAYS_FROM_LIVER_INJURY": days,
            "SERVICE_NAME": meta.get("SERVICE"),
        })

    if not records:
        return {"result": [], "message": f"No notes found for person_id={person_id}"}

    records.sort(key=lambda x: (x["DAYS_FROM_LIVER_INJURY"] is None, x["DAYS_FROM_LIVER_INJURY"]))
    return records
