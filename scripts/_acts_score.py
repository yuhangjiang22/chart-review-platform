#!/usr/bin/env python3
"""Per-field correctness scorer for an ACTS run vs ground truth.
Usage: python3 scripts/_acts_score.py <drafts.json> <patient_id> [label]
Type-aware matching: numeric=exact value; enum/derived=normalized equality;
free-text (allergen/vaccine_*)=order/case-insensitive set match. Fields absent
from GT are expected null/absent.
"""
import sys, json, re, pathlib, yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
CRIT = ROOT / ".claude/skills/chart-review-acts/references/criteria"
# entity-list fields: match on the SET of entity values (value_key), order/case-insensitive
ENTITY_VALUE_KEY = {"allergen": "Allergen", "vaccine_name": "Vaccine_Name"}


def schemas():
    out = {}
    for f in sorted(CRIT.glob("*.md")):
        m = re.match(r"^---\n(.*?)\n---", f.read_text(), re.S)
        fm = yaml.safe_load(m.group(1)) if m else {}
        out[fm.get("field_id") or f.stem] = fm or {}
    return out


def norm(x):
    return re.sub(r"\s+", " ", str(x)).strip().lower()


def as_set(x):
    return {norm(p) for p in re.split(r"[;,]", str(x)) if norm(p)}


def is_absent(x):
    return x is None or norm(x) in ("", "na", "n/a", "none", "null")


def entity_values(x, key):
    if not isinstance(x, list):
        return None
    out = set()
    for r in x:
        if not (isinstance(r, dict) and r.get(key)):
            continue
        v = re.sub(r"\s+(vaccine|vaccines|vaccination|vaccinations|immunization)$", "", norm(r.get(key))).strip()
        if v:
            out.add(v)
    return out


def match(fid, sch, exp, got):
    # entity-list fields: compare the set of entity values
    if fid in ENTITY_VALUE_KEY:
        key = ENTITY_VALUE_KEY[fid]
        if exp is None:  # not documented → expect empty/absent
            return got is None or (isinstance(got, list) and len(got) == 0)
        return entity_values(exp, key) == entity_values(got, key)
    exp_absent, got_absent = (exp is None or is_absent(exp)), is_absent(got)
    if exp_absent:
        return got_absent  # expected not-documented → got should be null/absent
    if got_absent:
        return False
    t = (sch.get("answer_schema") or {}).get("type")
    if t in ("integer", "number") and not (sch.get("answer_schema") or {}).get("enum"):
        try:
            return float(exp) == float(got)
        except (TypeError, ValueError):
            return norm(exp) == norm(got)
    return norm(exp) == norm(got)


def main():
    drafts_fp, pid = sys.argv[1], sys.argv[2]
    label = sys.argv[3] if len(sys.argv) > 3 else ""
    sch = schemas()
    gt = json.load(open(ROOT / "corpus/patients" / pid / "ground_truth.json"))
    expected = gt.get("leaf_answers") or {}
    d = json.load(open(drafts_fp))
    got = {}
    for dr in d.get("drafts", []):
        for fa in dr.get("field_assessments", []):
            got[fa["field_id"]] = fa.get("answer")

    print(f"=== PER-FIELD SCORE  {label}  (patient {pid}) ===")
    print(f"{'field':24} {'expected':28} {'got':28} ok")
    print("-" * 86)
    npass = ntot = 0
    fails = []
    for fid in sorted(sch):
        exp = expected.get(fid)
        g = got.get(fid)
        ok = match(fid, sch[fid], exp, g)
        ntot += 1
        npass += 1 if ok else 0
        if not ok:
            fails.append(fid)
        if fid in ENTITY_VALUE_KEY:
            key = ENTITY_VALUE_KEY[fid]
            ex_s = "(absent)" if exp is None else "{" + "; ".join(sorted(entity_values(exp, key) or set())) + "}"
            g_s = "(absent)" if g is None else (
                "{" + "; ".join(sorted(entity_values(g, key) or set())) + "}" if isinstance(g, list) else str(g))
        else:
            ex_s = "(absent)" if (exp is None or is_absent(exp)) else str(exp)
            g_s = "(absent)" if is_absent(g) else str(g)
        print(f"{fid:24} {ex_s[:27]:28} {g_s[:27]:28} {'✓' if ok else '✗'}")
    print("-" * 86)
    print(f"PASS {npass}/{ntot}" + (f"   FAILS: {fails}" if fails else "   — all fields correct"))


if __name__ == "__main__":
    main()
