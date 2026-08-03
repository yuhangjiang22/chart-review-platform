from enum import Enum
from pathlib import Path
from typing import Optional, Tuple

import pandas as pd

# RUCAM default ULNs per guideline (used only if no per-row ULN in lft_series.csv)
ULN_ALT = 52.0
ULN_ALP = 125.0


class RUCAM_INJURY_TYPE(str, Enum):
    HEPATOCELLULAR = "hepatocellular"
    CHOLESTATIC = "cholestatic"
    MIXED = "mixed"
    UNKNOWN = "unknown"


def compute_r_ratio_derivation(person_id: int, data_dir: str = "data") -> Optional[dict]:
    """Return a dict documenting how R ratio was computed for a patient.
    Fields: alt_value, alt_uln, alt_uln_source, alt_date; alp_value, alp_uln,
    alp_uln_source, alp_date; formula; r_ratio. Returns None if ALT or ALP is
    missing at T0 (DAYS_FROM_LIVER_INJURY=0). Uses max value if multiple readings."""
    path = Path(data_dir) / "lft_series.csv"
    if not path.exists():
        return None
    df = pd.read_csv(path)
    df = df[df["PERSON_ID"] == person_id]
    t0 = df[df["DAYS_FROM_LIVER_INJURY"] == 0]
    alt_rows = t0[t0["LAB_NAME"] == "ALT"]
    alp_rows = t0[t0["LAB_NAME"] == "ALP"]
    if alt_rows.empty or alp_rows.empty:
        return None

    alt_row = alt_rows.loc[alt_rows["VALUE_AS_NUMBER"].idxmax()]
    alp_row = alp_rows.loc[alp_rows["VALUE_AS_NUMBER"].idxmax()]
    alt_v = float(alt_row["VALUE_AS_NUMBER"])
    alp_v = float(alp_row["VALUE_AS_NUMBER"])
    alt_uln_raw = alt_row.get("ULN")
    alp_uln_raw = alp_row.get("ULN")
    alt_uln = float(alt_uln_raw) if pd.notna(alt_uln_raw) else ULN_ALT
    alp_uln = float(alp_uln_raw) if pd.notna(alp_uln_raw) else ULN_ALP
    r = (alt_v / alt_uln) / (alp_v / alp_uln) if (alt_v > 0 and alp_v > 0 and alt_uln > 0 and alp_uln > 0) else None
    return {
        "alt_value": alt_v,
        "alt_uln": alt_uln,
        "alt_uln_source": "per_row" if pd.notna(alt_uln_raw) else "default_52",
        "alt_date": str(alt_row.get("MEASUREMENT_DATE", "")),
        "alp_value": alp_v,
        "alp_uln": alp_uln,
        "alp_uln_source": "per_row" if pd.notna(alp_uln_raw) else "default_125",
        "alp_date": str(alp_row.get("MEASUREMENT_DATE", "")),
        "formula": f"({alt_v}/{alt_uln}) / ({alp_v}/{alp_uln})",
        "r_ratio": round(r, 2) if r is not None else None,
    }


def compute_r_ratio(
    person_id: int, data_dir: str = "data"
) -> Tuple[Optional[float], RUCAM_INJURY_TYPE]:
    """Compute R ratio and injury type at episode onset (T0 = liver injury date).

    Per RUCAM guideline v7:
      R = (ALT / ALT_ULN) ÷ (ALP / ALP_ULN), evaluated at T0.
      R > 5 → hepatocellular
      R < 2 → cholestatic
      2 ≤ R ≤ 5 → mixed

    Uses per-row ULN from lft_series.csv when available; falls back to defaults
    (ALT_ULN=52, ALP_ULN=125). If multiple readings on T0, uses the max.
    If ALT or ALP is missing on T0, returns (None, UNKNOWN).
    """
    path = Path(data_dir) / "lft_series.csv"
    if not path.exists():
        raise FileNotFoundError(f"Required file not found: {path}")
    df = pd.read_csv(path)
    df = df[df["PERSON_ID"] == person_id]

    t0 = df[df["DAYS_FROM_LIVER_INJURY"] == 0]
    alt_rows = t0[t0["LAB_NAME"] == "ALT"]
    alp_rows = t0[t0["LAB_NAME"] == "ALP"]

    if alt_rows.empty or alp_rows.empty:
        return None, RUCAM_INJURY_TYPE.UNKNOWN

    alt_row = alt_rows.loc[alt_rows["VALUE_AS_NUMBER"].idxmax()]
    alp_row = alp_rows.loc[alp_rows["VALUE_AS_NUMBER"].idxmax()]

    alt_v = float(alt_row["VALUE_AS_NUMBER"])
    alp_v = float(alp_row["VALUE_AS_NUMBER"])
    alt_uln = float(alt_row["ULN"]) if pd.notna(alt_row.get("ULN")) else ULN_ALT
    alp_uln = float(alp_row["ULN"]) if pd.notna(alp_row.get("ULN")) else ULN_ALP

    if alt_v <= 0 or alp_v <= 0 or alt_uln <= 0 or alp_uln <= 0:
        return None, RUCAM_INJURY_TYPE.UNKNOWN

    r = (alt_v / alt_uln) / (alp_v / alp_uln)

    if r > 5:
        injury_type = RUCAM_INJURY_TYPE.HEPATOCELLULAR
    elif r < 2:
        injury_type = RUCAM_INJURY_TYPE.CHOLESTATIC
    else:
        injury_type = RUCAM_INJURY_TYPE.MIXED

    return round(r, 2), injury_type
