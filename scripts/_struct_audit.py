#!/usr/bin/env python3
"""Output-structure audit. Validates every field_assessment in a drafts JSON
against its compiled criterion schema (read from the task's criteria .md
frontmatter). PHI-SAFE: reports field_id + violation CLASS only — never the
answer value or evidence text.

Usage: python3 scripts/_struct_audit.py <drafts.json> <task_id> [per_note|patient_level]
"""
import sys, json, re, pathlib, yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_schemas(task):
    d = ROOT / ".claude" / "skills" / f"chart-review-{task}" / "references" / "criteria"
    out = {}
    for f in sorted(d.glob("*.md")):
        m = re.match(r"^---\n(.*?)\n---", f.read_text(), re.S)
        if not m:
            continue
        fm = yaml.safe_load(m.group(1)) or {}
        out[fm.get("field_id") or f.stem] = fm
    return out


def main():
    drafts_fp, task = sys.argv[1], sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else "auto"
    schemas = load_schemas(task)
    derived = {fid for fid, s in schemas.items() if s.get("derivation")}
    gated = {fid for fid, s in schemas.items() if s.get("is_applicable_when")}

    data = json.load(open(drafts_fp))
    fas = []
    for dr in data.get("drafts", []):
        fas.extend(dr.get("field_assessments", []))

    viol = []   # (field_id, class)
    seen = set()
    for fa in fas:
        fid = fa.get("field_id"); ans = fa.get("answer"); seen.add(fid)
        s = schemas.get(fid)
        if not s:
            viol.append((fid, "unknown_field")); continue
        sch = s.get("answer_schema") or {}
        enum, typ = sch.get("enum"), sch.get("type")
        lo, hi = sch.get("minimum"), sch.get("maximum")
        # answer conformance (null/empty always allowed = not documented)
        if ans not in (None, ""):
            if enum is not None:
                if str(ans) not in [str(x) for x in enum]:
                    viol.append((fid, "enum_violation"))
            elif typ in ("integer", "number"):
                try:
                    n = float(ans)
                    if typ == "integer" and n != int(n): viol.append((fid, "not_integer"))
                    if lo is not None and n < lo: viol.append((fid, "below_minimum"))
                    if hi is not None and n > hi: viol.append((fid, "above_maximum"))
                except (TypeError, ValueError):
                    viol.append((fid, "not_a_number"))
            elif typ == "string":
                if not isinstance(ans, str): viol.append((fid, "not_a_string"))
        # evidence well-formedness
        for ev in (fa.get("evidence") or []):
            src = ev.get("source")
            if src == "note":
                if not (ev.get("note_id") and ev.get("verbatim_quote") and ev.get("span_offsets")):
                    viol.append((fid, "malformed_note_evidence"))
            elif src not in ("omop",):
                viol.append((fid, "bad_evidence_source"))
        # encounter scoping per mode
        enc = fa.get("encounter_id")
        if mode == "per_note" and not enc: viol.append((fid, "missing_encounter_id"))
        if mode == "patient_level" and enc: viol.append((fid, "unexpected_encounter_id"))

    print(f"=== STRUCT AUDIT  task={task}  mode={mode} ===")
    print(f"assessments={len(fas)}  distinct_fields={len(seen)}  "
          f"criteria_defined={len(schemas)} (derived={len(derived)}, gated={len(gated)})")
    # derived fields must NOT be agent-written (they're computed); flag any agent-authored derived
    agent_derived = sorted({fa.get("field_id") for fa in fas
                            if fa.get("field_id") in derived and fa.get("updated_by") == "agent"})
    if agent_derived:
        print(f"⚠ derived fields written by the AGENT (should be auto-computed): {agent_derived}")
    if viol:
        from collections import Counter
        print(f"\nVIOLATIONS ({len(viol)}):")
        for (fid, cls) in sorted(set(viol)):
            cnt = sum(1 for v in viol if v == (fid, cls))
            print(f"  {fid:26} {cls:24} x{cnt}")
    else:
        print("\nNO STRUCTURE VIOLATIONS ✓")
    print(f"derived present: {sorted(seen & derived) or '(none)'}")


if __name__ == "__main__":
    main()
