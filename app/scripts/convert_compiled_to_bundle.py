#!/usr/bin/env python3
"""
One-shot converter: tasks/compiled/<task_id>.json → bundle dir at tasks/<task_id>/.
Reads each compiled JSON, splits into:
  - tasks/<task_id>/SKILL.md (frontmatter + narrative + criteria summary table)
  - tasks/<task_id>/meta.yaml (top-level task metadata excluding `fields`)
  - tasks/<task_id>/criteria/<field_id>.yaml (one per field)
"""
import json
import sys
from pathlib import Path

import yaml


def main(compiled_dir: Path, tasks_dir: Path) -> int:
    if not compiled_dir.exists():
        print(f"compiled_dir not found: {compiled_dir}", file=sys.stderr)
        return 1
    converted = 0
    for jf in sorted(compiled_dir.glob("*.json")):
        task_id = jf.stem
        try:
            data = json.loads(jf.read_text())
        except Exception as e:
            print(f"  skip {jf.name}: {e}", file=sys.stderr)
            continue
        if not isinstance(data, dict) or "fields" not in data:
            print(f"  skip {jf.name}: no `fields` key", file=sys.stderr)
            continue
        bundle_dir = tasks_dir / task_id
        criteria_dir = bundle_dir / "criteria"
        criteria_dir.mkdir(parents=True, exist_ok=True)

        # meta.yaml (everything except task_id and fields)
        meta = {k: v for k, v in data.items() if k not in ("task_id", "fields")}
        (bundle_dir / "meta.yaml").write_text(yaml.safe_dump(meta, sort_keys=False))

        # criteria/<id>.yaml
        for f in data["fields"]:
            fid = f["id"]
            (criteria_dir / f"{fid}.yaml").write_text(yaml.safe_dump(f, sort_keys=False))

        # SKILL.md
        rows = []
        for f in data["fields"]:
            applies = f.get("is_applicable_when", "always")
            schema = f.get("answer_schema", {})
            if isinstance(schema, dict) and "enum" in schema:
                ans = "enum [" + ", ".join(str(v) for v in schema["enum"]) + "]"
            else:
                ans = "free"
            rows.append(f"| {f['id']} | {applies} | {ans} |")
        summary_table = "\n".join(rows) if rows else "| (no criteria) | | |"
        human_name = task_id.replace("_", " ")
        skill_md = f"""---
name: {task_id.replace('_', '-')}
description: Use when reviewing a chart for {human_name}. Applies the rubric across {len(data['fields'])} criteria.
---

# {task_id.replace('_', '-')}

## Procedure

1. For each criterion in `criteria/`, evaluate `is_applicable_when` against the record's prior answers. Skip if false.
2. Read `prompt`, `guidance`, and `examples` from the criterion YAML. Use evidence-search tools to find supporting spans.
3. Emit the answer in the shape declared by `answer_schema`.

## Criteria summary

| Criterion | Applies when | Answer type |
|---|---|---|
{summary_table}
"""
        (bundle_dir / "SKILL.md").write_text(skill_md)
        print(f"  converted {task_id} ({len(data['fields'])} criteria)")
        converted += 1
    print(f"\nConverted {converted} task(s).")
    return 0


if __name__ == "__main__":
    here = Path(__file__).resolve().parent.parent.parent  # app/scripts/ -> app/ -> chart-review-platform/
    compiled = here / "tasks" / "compiled"
    tasks = here / "tasks"
    sys.exit(main(compiled, tasks))
