#!/usr/bin/env python3
"""
omop_etl.py — Asthma Adherence per-patient OMOP extraction pipeline.

Reads a cohort CSV (output of cohort.sql), runs the 6 per-patient extracts
from extracts.sql against the source CDM, and writes platform-shaped JSON
files into:

  <output_dir>/<anon_id>/meta.json
  <output_dir>/<anon_id>/omop/conditions.json
  <output_dir>/<anon_id>/omop/drugs.json
  <output_dir>/<anon_id>/omop/measurements.json
  <output_dir>/<anon_id>/omop/observations.json
  <output_dir>/<anon_id>/omop/procedures.json
  <output_dir>/<anon_id>/omop/encounters.json

The platform's `read_structured_data` MCP tool consumes these directly.

Usage:
  export DATABASE_URL='mssql+pyodbc://user:pass@host/db?driver=ODBC+Driver+17'
  export ANON_SALT='shared-secret-between-sites-2026'

  python omop_etl.py \\
      --cohort-csv cohort.csv \\
      --site-prefix iu \\
      --output-dir ./corpus/patients \\
      --schema omop_cdm \\
      --lookback-days 365

Required: sqlalchemy >= 2.0, pandas >= 2.0, plus a DBAPI driver
(pyodbc for SQL Server, psycopg2 for Postgres, snowflake-sqlalchemy, etc.).

Note: extracts.sql is T-SQL flavored. For Postgres/Snowflake either run
through OHDSI SqlRender first or edit the SQL inline.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("omop_etl")


# Map RxNorm ingredient concept_id → (drug_class, is_controller).
# Sites MUST agree on this map for cross-site cohort comparability.
DRUG_CLASS_MAP = {
    1149380: ("ICS", True),       # fluticasone propionate
    905375:  ("ICS", True),       # budesonide
    1118084: ("ICS", True),       # mometasone
    1115008: ("ICS", True),       # beclomethasone
    1135766: ("ICS-LABA", True),  # fluticasone-salmeterol
    1149375: ("ICS-LABA", True),  # budesonide-formoterol
    40161532:("ICS-LABA", True),  # mometasone-formoterol
    904424:  ("LTRA", True),      # montelukast
    40224089:("LTRA", True),      # zafirlukast
    44507676:("biologic", True),  # omalizumab
    44818489:("biologic", True),  # mepolizumab
    35605482:("biologic", True),  # benralizumab
    35200139:("biologic", True),  # dupilumab
    1112807: ("SABA", False),     # albuterol
    1133905: ("SABA", False),     # levalbuterol
    1149196: ("LAMA", True),      # tiotropium
    975125:  ("OCS", False),      # prednisone
    1506270: ("OCS", False),      # methylprednisolone
}


def load_sql_sections(sql_path: Path) -> dict[str, str]:
    """Parse extracts.sql into a dict keyed by '==NAME foo==' markers."""
    raw = sql_path.read_text()
    sections: dict[str, str] = {}
    current_name: str | None = None
    buf: list[str] = []
    for line in raw.splitlines():
        m = re.match(r"--\s*==NAME\s+(\w+)==\s*$", line)
        if m:
            if current_name:
                sections[current_name] = "\n".join(buf).strip()
            current_name = m.group(1)
            buf = []
        elif current_name:
            buf.append(line)
    if current_name:
        sections[current_name] = "\n".join(buf).strip()
    return sections


def anonymize(person_id: int | str, site_prefix: str, salt: str) -> str:
    h = hashlib.sha256(f"{salt}:{person_id}".encode()).hexdigest()[:10]
    return f"{site_prefix}_{h}"


def to_jsonable(rows: pd.DataFrame) -> list[dict]:
    if rows.empty:
        return []
    out = []
    for r in rows.to_dict(orient="records"):
        clean: dict = {}
        for k, v in r.items():
            if pd.isna(v):
                clean[k] = None
            elif isinstance(v, (datetime, date, pd.Timestamp)):
                clean[k] = pd.Timestamp(v).date().isoformat()
            elif hasattr(v, "item"):  # numpy scalar
                clean[k] = v.item()
            else:
                clean[k] = v
        out.append(clean)
    return out


def assemble_drugs(regimens: pd.DataFrame, fills: pd.DataFrame,
                   engine: Engine, sig_sql: str, schema: str,
                   person_id: int, lookback_end: date) -> list[dict]:
    out = []
    fills_by_concept = {cid: g.to_dict(orient="records")
                        for cid, g in fills.groupby("concept_id")}

    for row in regimens.to_dict(orient="records"):
        cid = row["concept_id"]
        klass_entry = DRUG_CLASS_MAP.get(cid)
        if klass_entry is None:
            continue  # ignore meds not in the asthma allowlist
        klass, is_controller = klass_entry

        with engine.connect() as conn:
            sig = conn.execute(
                text(sig_sql.format(schema=schema)),
                {"person_id": person_id, "ingredient_id": cid},
            ).scalar()

        fills_list = fills_by_concept.get(cid, [])
        fills_12mo = [f for f in fills_list
                      if (lookback_end - f["fill_date"]).days <= 365]

        drug = {
            "row_id": int(row["row_id"]),
            "concept_id": int(cid),
            "concept_name": row["concept_name"],
            "rxnorm": row["rxnorm"],
            "drug_class": klass,
            "is_controller": bool(is_controller),
            "instructions": sig,
            "start_date": pd.Timestamp(row["start_date"]).date().isoformat(),
            "end_date": (pd.Timestamp(row["end_date"]).date().isoformat()
                         if not pd.isna(row["end_date"]) else None),
            "active": bool(row["active"]),
            "fills": [
                {
                    "fill_date": pd.Timestamp(f["fill_date"]).date().isoformat(),
                    "days_supply": int(f["days_supply"] or 0),
                    "quantity": int(f["quantity"] or 0),
                }
                for f in fills_list
            ],
        }

        if is_controller:
            days_covered = sum(int(f["days_supply"] or 0) for f in fills_12mo)
            drug["refill_pdc_12mo"] = round(min(1.0, days_covered / 365.0), 2)
        if klass == "SABA":
            drug["saba_canisters_12mo"] = sum(int(f["quantity"] or 0)
                                              for f in fills_12mo)
        out.append(drug)
    return out


def write_atomic(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str))
    tmp.replace(path)


def write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


import re as _re


def slugify_doc_type(s: str | None) -> str:
    """date__doc-type filename component. Lowercase, alphanumerics +
    underscores only, max 40 chars."""
    if not s:
        return "note"
    out = _re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")
    return out[:40] or "note"


def write_notes(
    notes_df: pd.DataFrame,
    pdir: Path,
) -> int:
    """Persist each row of the notes query as a .txt file under
    <pdir>/notes/<YYYY-MM-DD>__<slug>.txt. Returns the file count.
    Disambiguates collisions (same date + same slug) with -2, -3, ..."""
    notes_dir = pdir / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)
    # Clear any stale files from a prior run so re-extraction is idempotent.
    for old in notes_dir.glob("*.txt"):
        try: old.unlink()
        except OSError: pass

    used: set[str] = set()
    written = 0
    for row in notes_df.to_dict(orient="records"):
        text = row.get("note_text")
        if not isinstance(text, str) or len(text.strip()) == 0:
            continue
        date_val = row.get("note_date")
        date_str = (pd.Timestamp(date_val).date().isoformat()
                    if date_val is not None and not pd.isna(date_val) else "0000-00-00")
        slug = slugify_doc_type(row.get("doc_type"))
        base = f"{date_str}__{slug}"
        name = f"{base}.txt"
        n = 2
        while name in used:
            name = f"{base}-{n}.txt"; n += 1
        used.add(name)
        write_text_atomic(notes_dir / name, text)
        written += 1
    return written


def extract_patient(engine: Engine, sql: dict[str, str], schema: str,
                    person_id: int, index_date: date, lookback_days: int,
                    anon_id: str, output_dir: Path,
                    age: int, gender_concept_id: int) -> dict:
    start = index_date - timedelta(days=lookback_days)
    end = index_date
    params = {"person_id": person_id, "start_date": start, "end_date": end}

    def run(name: str) -> pd.DataFrame:
        return pd.read_sql(text(sql[name].format(schema=schema)),
                           engine, params=params)

    conditions    = to_jsonable(run("conditions"))
    drug_regimens = run("drug_regimens")
    drug_fills    = run("drug_fills")
    drugs         = assemble_drugs(drug_regimens, drug_fills, engine,
                                   sql["drug_sig"], schema, person_id, end)
    measurements  = to_jsonable(run("measurements"))
    observations  = to_jsonable(run("observations"))
    procedures    = to_jsonable(run("procedures"))
    encounters    = to_jsonable(run("encounters"))
    notes_df      = run("notes") if "notes" in sql else pd.DataFrame()

    pdir = output_dir / anon_id
    write_atomic(pdir / "omop" / "conditions.json",   conditions)
    write_atomic(pdir / "omop" / "drugs.json",        drugs)
    write_atomic(pdir / "omop" / "measurements.json", measurements)
    write_atomic(pdir / "omop" / "observations.json", observations)
    write_atomic(pdir / "omop" / "procedures.json",   procedures)
    write_atomic(pdir / "omop" / "encounters.json",   encounters)
    n_notes = write_notes(notes_df, pdir) if not notes_df.empty else 0

    meta = {
        "patient_id": anon_id,
        "category": "asthma_adherence",
        "demographics": {"age": age, "gender_concept_id": gender_concept_id},
        "index_date": index_date.isoformat(),
        "lookback_start_date": start.isoformat(),
        "extracted_at": datetime.now().isoformat(),
        "source_schema": schema,
    }
    write_atomic(pdir / "meta.json", meta)

    return {
        "anon_id": anon_id,
        "n_conditions":   len(conditions),
        "n_drugs":        len(drugs),
        "n_measurements": len(measurements),
        "n_observations": len(observations),
        "n_procedures":   len(procedures),
        "n_encounters":   len(encounters),
        "n_notes":        n_notes,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cohort-csv", required=True, type=Path,
                    help="Output of cohort.sql")
    ap.add_argument("--output-dir", required=True, type=Path,
                    help="Where to write <anon_id>/ subdirs")
    ap.add_argument("--site-prefix", required=True,
                    help="2-3 char site code (e.g. 'iu', 'cor')")
    ap.add_argument("--anon-salt", default=os.environ.get("ANON_SALT", ""),
                    help="HMAC-style salt; set ANON_SALT env var instead "
                         "of passing on cmdline to avoid shell history leak")
    ap.add_argument("--schema", default="omop_cdm",
                    help="OMOP CDM schema name")
    ap.add_argument("--lookback-days", type=int, default=365)
    ap.add_argument("--sql-dir", type=Path,
                    default=Path(__file__).parent,
                    help="Directory containing extracts.sql")
    args = ap.parse_args()

    if not args.anon_salt:
        log.warning("No anon-salt set — anon_ids will be reproducible by "
                    "anyone with the same person_ids. Set ANON_SALT env "
                    "var for real cohorts.")

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL env var not set"); sys.exit(2)

    sql_path = args.sql_dir / "extracts.sql"
    if not sql_path.exists():
        log.error(f"extracts.sql not found at {sql_path}"); sys.exit(2)
    sql = load_sql_sections(sql_path)
    required = {"conditions", "drug_regimens", "drug_fills", "drug_sig",
                "measurements", "observations", "procedures", "encounters"}
    missing = required - set(sql)
    if missing:
        log.error(f"extracts.sql is missing sections: {missing}"); sys.exit(2)
    if "notes" not in sql:
        log.warning("extracts.sql has no `notes` section — extraction will skip notes. "
                    "Add the ==NAME notes== block to pull clinical text.")

    engine = create_engine(db_url)
    cohort = pd.read_csv(args.cohort_csv, parse_dates=["index_date"])
    log.info(f"Cohort size: {len(cohort)} patients")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    errors = []

    for i, row in cohort.iterrows():
        person_id = int(row["person_id"])
        anon_id = anonymize(person_id, args.site_prefix, args.anon_salt)
        try:
            summary = extract_patient(
                engine=engine,
                sql=sql,
                schema=args.schema,
                person_id=person_id,
                index_date=row["index_date"].date(),
                lookback_days=args.lookback_days,
                anon_id=anon_id,
                output_dir=args.output_dir,
                age=int(row["age_at_index"]),
                gender_concept_id=int(row["gender_concept_id"]),
            )
            manifest.append(summary)
            log.info(f"[{i+1}/{len(cohort)}] {anon_id}: "
                     f"cond={summary['n_conditions']} "
                     f"drug={summary['n_drugs']} "
                     f"meas={summary['n_measurements']} "
                     f"enc={summary['n_encounters']} "
                     f"notes={summary.get('n_notes', 0)}")
        except Exception as e:
            log.exception(f"[{i+1}/{len(cohort)}] person_id={person_id} FAILED")
            errors.append({"person_id": person_id, "anon_id": anon_id,
                           "error": str(e)})

    write_atomic(args.output_dir / "_manifest.json", {
        "site_prefix": args.site_prefix,
        "schema": args.schema,
        "extracted_at": datetime.now().isoformat(),
        "lookback_days": args.lookback_days,
        "n_patients_attempted": len(cohort),
        "n_patients_extracted": len(manifest),
        "n_patients_failed": len(errors),
        "patients": manifest,
        "errors": errors,
    })

    log.info(f"Done. {len(manifest)} extracted, {len(errors)} failed. "
             f"See {args.output_dir/'_manifest.json'}")


if __name__ == "__main__":
    main()
