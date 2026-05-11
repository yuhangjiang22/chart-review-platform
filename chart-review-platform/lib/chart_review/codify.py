"""Codify skill — deterministic extractor.

Walks (package_dir, reviews_root, task_id) and produces an in-memory bundle
of three artifact families: keyword_sets, code_sets, note_type_filters.
Pure function — no I/O outside reading the inputs.

Pairs with codify_writer (Task 6) which serializes the bundle to disk.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml

from chart_review.codify_icd_prefix import group_icd_prefixes
from chart_review.codify_tokenizer import extract_ngrams


_VALIDATED_STATUSES = frozenset({"reviewer_validated", "locked"})
_KEYWORD_TOP_N = 30
_NOTE_TYPE_HIGH_THRESHOLD = 0.80
_NOTE_TYPE_MEDIUM_THRESHOLD = 0.30


def _read_meta(package_dir: Path) -> dict:
    return yaml.safe_load((package_dir / "meta.yaml").read_text()) or {}


def _list_validated_reviews(reviews_root: Path, task_id: str) -> list[dict]:
    """Walk reviews_root for review_state.json files at <patient>/<task_id>/.

    A "validated" review is one where the persisted ``review_status`` is
    ``reviewer_validated`` or ``locked``. The ``oracle_done`` flag is a
    *computed* status surfaced at the API layer (pilot-routes.ts), not a
    persisted field on review_state.json, so we cannot rely on it here.
    The persisted review_status is the canonical signal of validation.
    """
    out = []
    if not reviews_root.is_dir():
        return out
    for patient_dir in sorted(reviews_root.iterdir()):
        if not patient_dir.is_dir():
            continue
        rs_path = patient_dir / task_id / "review_state.json"
        if not rs_path.is_file():
            continue
        try:
            rs = json.loads(rs_path.read_text())
        except json.JSONDecodeError:
            continue
        if rs.get("review_status") not in _VALIDATED_STATUSES:
            continue
        out.append(rs)
    return out


def _note_type_for(evidence: dict, note_metadata: dict[str, str]) -> str:
    """Resolve a note's type from doc_type or fallback to a metadata catalog."""
    doc_type = evidence.get("doc_type")
    if isinstance(doc_type, str) and doc_type:
        return doc_type
    note_id = evidence.get("note_id", "")
    return note_metadata.get(note_id, "unknown")


def codify(
    *,
    package_dir: Path,
    reviews_root: Path,
    task_id: str,
    note_metadata: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run the codify extractor.

    Args:
        package_dir: locked guideline at .claude/skills/chart-review-<task>/
        reviews_root: usually <repo>/chart-review-platform/var/reviews/
        task_id: matches the per-patient subdirectory name
        note_metadata: optional {note_id: note_type} catalog. If None, the
            extractor relies on doc_type already on the evidence row, falling
            back to "unknown".

    Returns:
        {
          "keyword_sets": {<kw_id>: {<frontmatter dict>}, ...},
          "code_sets":    {<codes_id>: {<frontmatter dict>}, ...},
          "note_type_filters": {<frontmatter dict>},
          "guideline_manual_version": str,
          "cohort_size": int,
        }

    Raises:
        ValueError: when no validated patients are found.
    """
    note_metadata = note_metadata or {}
    package_dir = Path(package_dir)
    reviews_root = Path(reviews_root)

    meta = _read_meta(package_dir)
    manual_version = str(meta.get("manual_version", "unknown"))

    reviews = _list_validated_reviews(reviews_root, task_id)
    if not reviews:
        raise ValueError(
            f"no validated patients found under {reviews_root} for task {task_id!r}"
        )

    cohort_size = len(reviews)

    # Per-criterion accumulators.
    # term_stats[fid][term] = (patient_set, total_count)
    kw_patients: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    kw_total: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    # codes[fid][concept_id] = (concept_name, source_table, code, patient_set)
    code_patients: dict[str, dict[Any, dict[str, Any]]] = defaultdict(dict)
    # all ICD-like codes seen per field (for prefix grouping; may exceed concept dedup)
    all_icd_codes: dict[str, set[str]] = defaultdict(set)
    # note_type[fid][note_type] = patient_set
    note_type_patients: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))

    for rs in reviews:
        pid = rs["patient_id"]
        # Walk per-field evidence.
        for fa in rs.get("field_assessments", []):
            fid = fa.get("field_id")
            if not fid:
                continue
            # Only count assessments the reviewer touched. Skip
            # source=agent rows that the reviewer didn't approve away from.
            if fa.get("source") != "reviewer":
                continue
            for ev in fa.get("evidence", []):
                _accumulate_evidence(
                    ev, fid, pid, kw_patients, kw_total,
                    code_patients, all_icd_codes, note_type_patients, note_metadata,
                )
        # Walk free-floating selected_evidence — only count entries that
        # carry a field_id (otherwise we can't attribute them) and were
        # added by the reviewer (mirrors the field_assessments source guard).
        for sev in rs.get("selected_evidence", []):
            if sev.get("added_by") != "reviewer":
                continue
            fid = sev.get("field_id")
            if not fid:
                continue
            ev = sev.get("evidence", {})
            _accumulate_evidence(
                ev, fid, pid, kw_patients, kw_total,
                code_patients, all_icd_codes, note_type_patients, note_metadata,
            )

    now = _dt.datetime.now(_dt.timezone.utc).isoformat()
    derived_from_base = {
        "cohort_size": cohort_size,
        "cohort_oracle_done_count": cohort_size,
        "codified_at": now,
        "guideline_manual_version": manual_version,
    }

    keyword_sets = _build_keyword_sets(kw_patients, kw_total, derived_from_base)
    code_sets = _build_code_sets(code_patients, all_icd_codes, derived_from_base)
    note_type_filters = _build_note_type_filters(
        note_type_patients, cohort_size, derived_from_base,
    )

    return {
        "keyword_sets": keyword_sets,
        "code_sets": code_sets,
        "note_type_filters": note_type_filters,
        "guideline_manual_version": manual_version,
        "cohort_size": cohort_size,
    }


def _accumulate_evidence(
    ev: dict,
    fid: str,
    pid: str,
    kw_patients,
    kw_total,
    code_patients,
    all_icd_codes,
    note_type_patients,
    note_metadata,
):
    if not isinstance(ev, dict):
        return
    src = ev.get("source")
    if src == "note":
        quote = ev.get("verbatim_quote", "")
        if isinstance(quote, str) and quote:
            for term in extract_ngrams(quote):
                kw_patients[fid][term].add(pid)
                kw_total[fid][term] += 1
        # Note-type from doc_type or metadata catalog.
        nt = _note_type_for(ev, note_metadata)
        note_type_patients[fid][nt].add(pid)
    elif src in ("omop", "structured"):
        cid = ev.get("concept_id")
        if cid is None:
            return
        code_val = str(ev.get("value", "")) if ev.get("value") is not None else ""
        # Track all distinct ICD-like code values seen for prefix grouping.
        if code_val:
            all_icd_codes[fid].add(code_val)
        existing = code_patients[fid].get(cid)
        if existing is None:
            code_patients[fid][cid] = {
                "concept_id": cid,
                "concept_name": ev.get("concept_name", ""),
                "source_table": ev.get("table", ""),
                "code": code_val,
                "patient_set": {pid},
            }
        else:
            existing["patient_set"].add(pid)


def _build_keyword_sets(kw_patients, kw_total, derived_from_base) -> dict[str, dict]:
    out = {}
    for fid, term_to_patients in kw_patients.items():
        if not term_to_patients:
            continue
        # Rank by patient_count desc, then total_count desc, then term asc (stable).
        scored = []
        for term, patient_set in term_to_patients.items():
            scored.append({
                "term": term,
                "patient_count": len(patient_set),
                "total_count": kw_total[fid][term],
            })
        scored.sort(key=lambda s: (-s["patient_count"], -s["total_count"], s["term"]))
        top = scored[:_KEYWORD_TOP_N]
        kw_id = f"kw_{fid}"
        out[kw_id] = {
            "id": kw_id,
            "description": f"Anchor keywords for {fid}, codified from cohort.",
            "terms": [s["term"] for s in top],
            "term_stats": top,
            "derived_from": dict(derived_from_base),
            "provenance": {"source": "codify-derived"},
        }
    return out


def _build_code_sets(code_patients, all_icd_codes, derived_from_base) -> dict[str, dict]:
    out = {}
    for fid, codes in code_patients.items():
        if not codes:
            continue
        rows = []
        for cid, entry in codes.items():
            rows.append({
                "concept_id": cid,
                "concept_name": entry["concept_name"],
                "source_table": entry["source_table"],
                "code": entry["code"],
                "patient_count": len(entry["patient_set"]),
            })
        rows.sort(key=lambda r: (-r["patient_count"], str(r["concept_id"])))
        # Use all observed ICD codes (across patients) for prefix grouping,
        # not just the representative code stored per concept_id.
        all_codes_for_prefix: list[str] = sorted(all_icd_codes.get(fid, set()))
        prefix_groups = group_icd_prefixes(all_codes_for_prefix)
        # Attach patient_count to each prefix group (sum across members).
        for grp in prefix_groups:
            patient_set: set[str] = set()
            for cid, entry in codes.items():
                if entry["code"] in grp["members"]:
                    patient_set |= entry["patient_set"]
            grp["patient_count"] = len(patient_set)
        codes_id = f"codes_{fid}"
        out[codes_id] = {
            "id": codes_id,
            "description": f"OMOP/structured concept anchors for {fid}, codified from cohort.",
            "codes": rows,
            "prefix_hints": prefix_groups,
            "derived_from": dict(derived_from_base),
            "provenance": {"source": "codify-derived"},
        }
    return out


def _build_note_type_filters(
    note_type_patients, cohort_size, derived_from_base,
) -> dict:
    filters: dict[str, dict[str, list[str]]] = {}
    for fid, type_to_patients in note_type_patients.items():
        if not type_to_patients:
            continue
        high, medium, low = [], [], []
        for nt, patient_set in type_to_patients.items():
            coverage = len(patient_set) / cohort_size if cohort_size else 0.0
            if coverage >= _NOTE_TYPE_HIGH_THRESHOLD:
                high.append(nt)
            elif coverage >= _NOTE_TYPE_MEDIUM_THRESHOLD:
                medium.append(nt)
            else:
                low.append(nt)
        per = {}
        if high:   per["high"] = sorted(high)
        if medium: per["medium"] = sorted(medium)
        if low:    per["low"] = sorted(low)
        if per:
            filters[fid] = per
    return {
        "description": "Per-criterion note-type priority, codified from cohort.",
        "filters": filters,
        "derived_from": dict(derived_from_base),
        "provenance": {"source": "codify-derived"},
    }


# ── Writer ───────────────────────────────────────────────────────────────────


def _format_md(frontmatter: dict, body: str = "") -> str:
    """Serialize {<frontmatter>} + body as ---\\n<yaml>\\n---\\n<body>."""
    yml = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True)
    if not body:
        body = "\n"
    return f"---\n{yml}---\n{body}"


def write_artifacts(*, package_dir: Path, bundle: dict[str, Any]) -> list[Path]:
    """Serialize the in-memory bundle to disk under <package_dir>/references/.

    Returns the list of paths written. Idempotent: re-running with the same
    bundle produces files whose only difference is the `codified_at`
    timestamp inside `derived_from`.
    """
    package_dir = Path(package_dir)
    written: list[Path] = []

    kw_dir = package_dir / "references" / "keyword_sets"
    kw_dir.mkdir(parents=True, exist_ok=True)
    for kw_id, fm in bundle.get("keyword_sets", {}).items():
        body = "\n".join([
            f"# {kw_id}",
            "",
            f"Codify-derived keyword anchors for `{kw_id.removeprefix('kw_')}`.",
            "",
        ])
        out = kw_dir / f"{kw_id}.md"
        out.write_text(_format_md(fm, body))
        written.append(out)

    cs_dir = package_dir / "references" / "code_sets"
    cs_dir.mkdir(parents=True, exist_ok=True)
    for cs_id, fm in bundle.get("code_sets", {}).items():
        body = "\n".join([
            f"# {cs_id}",
            "",
            f"Codify-derived OMOP/structured concept anchors for `{cs_id.removeprefix('codes_')}`.",
            "",
        ])
        out = cs_dir / f"{cs_id}.md"
        out.write_text(_format_md(fm, body))
        written.append(out)

    nt = bundle.get("note_type_filters") or {}
    if nt.get("filters"):
        # Ensure references/ exists even when no keyword/code subdirs were
        # created (e.g. an extractor run that yields only note-type filters).
        (package_dir / "references").mkdir(parents=True, exist_ok=True)
        out = package_dir / "references" / "note_type_filters.md"
        body = "# note_type_filters\n\nCodify-derived per-criterion note-type priority.\n"
        out.write_text(_format_md(nt, body))
        written.append(out)

    return written


# ── uses-block mutation ──────────────────────────────────────────────────────

_FRONTMATTER_SPLIT_RE = re.compile(r"^(---\n)(.*?)(\n---\n)(.*)$", re.DOTALL)


def _split_md(text: str) -> tuple[dict, str, str, str]:
    """Return (frontmatter_dict, opening_fence, closing_fence_block, body)."""
    m = _FRONTMATTER_SPLIT_RE.match(text)
    if not m:
        raise ValueError("file lacks --- frontmatter fences")
    fm = yaml.safe_load(m.group(2)) or {}
    return fm, m.group(1), m.group(3), m.group(4)


def _merge_uses_array(
    existing: list[str] | None,
    new_codify_id: str,
) -> list[str]:
    """Add new_codify_id; replace the prior entry for this exact field; preserve others.

    Only the specific codify-derived ID for this field (``new_codify_id``) is
    replaced on re-run.  All other entries — including hand-authored entries
    that happen to share the same prefix — are preserved.
    """
    existing = existing or []
    # Remove only the prior codify-derived entry for this exact field id.
    # The field id is encoded in new_codify_id (e.g. kw_lung_pathology).
    # We do NOT drop all kw_* entries because hand-authored references may
    # also carry the same prefix (e.g. kw_my_hand_anchor).
    out = [eid for eid in existing if eid != new_codify_id]
    out.append(new_codify_id)
    return out


def update_uses_blocks(*, package_dir: Path, bundle: dict[str, Any]) -> list[Path]:
    """Update each criterion's uses.keyword_sets / uses.code_sets in place.

    For each kw_<fid> in bundle, ensure it appears in the matching criterion's
    `uses.keyword_sets` array, replacing any prior entry that begins with
    `kw_` and matches the same fid suffix. Hand-authored entries (those NOT
    starting with `kw_` / `codes_`) are preserved.

    Returns the list of criterion files modified.
    """
    package_dir = Path(package_dir)
    modified: list[Path] = []
    crit_dir = package_dir / "references" / "criteria"
    if not crit_dir.is_dir():
        return modified

    by_fid_kw = {kw_id.removeprefix("kw_"): kw_id for kw_id in bundle.get("keyword_sets", {})}
    by_fid_cs = {cs_id.removeprefix("codes_"): cs_id for cs_id in bundle.get("code_sets", {})}

    for md in sorted(crit_dir.glob("*.md")):
        text = md.read_text()
        try:
            fm, open_fence, close_fence, body = _split_md(text)
        except ValueError:
            continue
        fid = fm.get("field_id")
        if not isinstance(fid, str):
            continue

        changed = False
        new_kw = by_fid_kw.get(fid)
        new_cs = by_fid_cs.get(fid)

        if new_kw is not None:
            uses = fm.setdefault("uses", {})
            existing_kws = uses.get("keyword_sets")
            merged = _merge_uses_array(existing_kws, new_kw)
            if merged != existing_kws:
                uses["keyword_sets"] = merged
                changed = True

        if new_cs is not None:
            uses = fm.setdefault("uses", {})
            existing_css = uses.get("code_sets")
            merged = _merge_uses_array(existing_css, new_cs)
            if merged != existing_css:
                uses["code_sets"] = merged
                changed = True

        if changed:
            new_fm_yaml = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True)
            md.write_text(f"{open_fence}{new_fm_yaml.rstrip()}{close_fence}{body}")
            modified.append(md)

    return modified
