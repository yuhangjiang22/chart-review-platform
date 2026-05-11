"""CLI for the chart review backend.

Usage:
    chart-review compile <task.md>
    chart-review validate-task <compiled_task.json>
    chart-review validate-record <review_record.json>
    chart-review faithfulness <review_record.json> --notes-dir <dir>
    chart-review derive <compiled_task.json> <review_record.json>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .parser import parse_task_document
from .validator import validate_compiled_task, validate_review_record
from .derivation import evaluate_all, compute_applicability
from .faithfulness import check_record
from .alerts import detect_alerts
from .corpus import iter_patients, load_meta


def _contracts_dir(custom: str | None = None) -> Path:
    if custom:
        return Path(custom)
    # Walk up from this file: chart_review/cli.py → chart_review/ → lib/ → chart-review-platform/
    here = Path(__file__).resolve()
    candidate = here.parents[2] / "contracts"
    if candidate.exists():
        return candidate
    # Fallback: cwd/contracts
    return Path.cwd() / "contracts"


def _print_validation(result: dict, label: str) -> int:
    if result["status"] == "pass":
        print(f"✓ {label} validates")
        return 0
    print(f"✗ {label} FAILED ({len(result['errors'])} error(s)):")
    for e in result["errors"]:
        print(f"  - {e}")
    return 1


def cmd_compile(args) -> int:
    compiled = parse_task_document(Path(args.task_md))
    out = json.dumps(compiled, indent=2, ensure_ascii=False)
    if args.output:
        Path(args.output).write_text(out)
        print(f"Wrote {args.output} ({len(compiled['fields'])} fields)")
    else:
        print(out)
    if args.validate:
        result = validate_compiled_task(compiled, _contracts_dir(args.contracts))
        return _print_validation(result, "CompiledTask")
    return 0


def cmd_validate_task(args) -> int:
    compiled = json.loads(Path(args.compiled_json).read_text())
    result = validate_compiled_task(compiled, _contracts_dir(args.contracts))
    return _print_validation(result, "CompiledTask")


def cmd_validate_record(args) -> int:
    record = json.loads(Path(args.record_json).read_text())
    result = validate_review_record(record, _contracts_dir(args.contracts))
    return _print_validation(result, "ReviewRecord")


def cmd_faithfulness(args) -> int:
    record = json.loads(Path(args.record_json).read_text())
    results = check_record(record, Path(args.notes_dir))
    print(f"Faithfulness check across {len(results)} criterion assessments:")
    fail = 0
    for r in results:
        icon = {"pass": "✓", "partial": "~", "fail": "✗"}[r["status"]]
        print(f"  {icon} {r['field_id']}: {r['status']}")
        for d in r["details"]:
            print(f"      {d}")
        if r["status"] == "fail":
            fail += 1
    return 1 if fail else 0


def cmd_derive(args) -> int:
    compiled = json.loads(Path(args.compiled_json).read_text())
    record = json.loads(Path(args.record_json).read_text())
    leaf_values = {
        a["field_id"]: a.get("answer")
        for a in record.get("criterion_assessments", [])
    }
    derived = evaluate_all(compiled, leaf_values)
    # Recompute applicability across the *full* env (leaves + derived) for display
    full_env = {**leaf_values, **derived}
    applicability = compute_applicability(compiled, full_env)
    not_applicable = [fid for fid, s in applicability.items() if s == "not_applicable"]

    print("Derived values:")
    for fid, v in derived.items():
        marker = "  (n/a)" if applicability.get(fid) == "not_applicable" else ""
        print(f"  {fid} = {v!r}{marker}")

    if not_applicable:
        print(f"\nGated fields not applicable ({len(not_applicable)}):")
        for fid in not_applicable:
            field = next(f for f in compiled["fields"] if f["id"] == fid)
            gate = field.get("is_applicable_when", "")
            print(f"  {fid}  [gate: {gate}]")

    if compiled.get("final_output"):
        fo = compiled["final_output"]
        print(f"\nFinal output (`{fo}`): {derived.get(fo)!r}")
    # Also surface alerts
    alerts = detect_alerts(compiled, record)
    if alerts:
        print(f"\n{len(alerts)} cross-criterion alert(s):")
        for al in alerts:
            print(f"  [{al['severity']}] {al['description']}")
    return 0


def cmd_list_patients(args) -> int:
    root = Path(args.corpus_root)
    if not (root / "patients").is_dir():
        print(f"No patients/ directory under {root}", file=sys.stderr)
        return 1
    patients = list(iter_patients(root))
    if not patients:
        print(f"No patients found under {root}/patients/")
        return 0
    print(f"{len(patients)} patient(s) under {root}/patients/:")
    print()
    print(f"  {'patient_id':<40} {'category':<18} {'difficulty':<10}")
    print(f"  {'-'*40} {'-'*18} {'-'*10}")
    for p in patients:
        meta = load_meta(root, p["patient_id"])
        try:
            from .corpus import load_ground_truth
            gt = load_ground_truth(root, p["patient_id"])
            difficulty = gt.get("difficulty", "—")
        except FileNotFoundError:
            difficulty = "—"
        print(f"  {p['patient_id']:<40} {meta['category']:<18} {difficulty:<10}")
    return 0


def cmd_codify(args) -> int:
    from chart_review.codify import codify, update_uses_blocks, write_artifacts
    pkg = Path(args.package_dir) if args.package_dir else (
        Path(__file__).resolve().parents[2] / ".claude" / "skills" / f"chart-review-{args.task}"
    )
    reviews_root = Path(args.reviews_root) if args.reviews_root else (
        Path(__file__).resolve().parents[2] / "reviews"
    )
    bundle = codify(package_dir=pkg, reviews_root=reviews_root, task_id=args.task)
    written = write_artifacts(package_dir=pkg, bundle=bundle)
    modified = update_uses_blocks(package_dir=pkg, bundle=bundle)
    print(json.dumps({
        "written_files": [str(p) for p in written],
        "modified_criteria": [str(p) for p in modified],
        "cohort_size": bundle["cohort_size"],
        "guideline_manual_version": bundle["guideline_manual_version"],
    }, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="chart-review")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_compile = sub.add_parser("compile", help="Compile a task .md to CompiledTask JSON")
    p_compile.add_argument("task_md")
    p_compile.add_argument("-o", "--output", help="Write JSON to this path instead of stdout")
    p_compile.add_argument("--validate", action="store_true", help="Also validate the result")
    p_compile.add_argument("--contracts", help="Override contracts directory")
    p_compile.set_defaults(func=cmd_compile)

    p_vt = sub.add_parser("validate-task", help="Validate a CompiledTask JSON file")
    p_vt.add_argument("compiled_json")
    p_vt.add_argument("--contracts", help="Override contracts directory")
    p_vt.set_defaults(func=cmd_validate_task)

    p_vr = sub.add_parser("validate-record", help="Validate a ReviewRecord JSON file")
    p_vr.add_argument("record_json")
    p_vr.add_argument("--contracts", help="Override contracts directory")
    p_vr.set_defaults(func=cmd_validate_record)

    p_f = sub.add_parser("faithfulness", help="Check evidence offsets against note text")
    p_f.add_argument("record_json")
    p_f.add_argument("--notes-dir", required=True)
    p_f.set_defaults(func=cmd_faithfulness)

    p_d = sub.add_parser("derive", help="Evaluate derived fields and final output")
    p_d.add_argument("compiled_json")
    p_d.add_argument("record_json")
    p_d.set_defaults(func=cmd_derive)

    p_lp = sub.add_parser("list-patients", help="List patients in a corpus")
    p_lp.add_argument("--corpus-root", default="corpus", help="Path to the corpus directory")
    p_lp.set_defaults(func=cmd_list_patients)

    p_codify = sub.add_parser("codify", help="Codify a locked guideline against its validated cohort")
    p_codify.add_argument("--task", required=True, help="task_id")
    p_codify.add_argument("--package-dir", default=None, help="path to .claude/skills/chart-review-<task>/")
    p_codify.add_argument("--reviews-root", default=None, help="path to chart-review-platform/var/reviews/")
    p_codify.set_defaults(func=cmd_codify)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
