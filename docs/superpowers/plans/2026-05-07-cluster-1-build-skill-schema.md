# Cluster 1 — Build-skill schema fidelity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chart-review-build skill emit a guideline package that loads cleanly into the Studio task workspace — closing issues B1 (meta.yaml schema mismatch), B4 (no derivation expression for derived criteria), and A6 (TODO placeholders shipped in extraction guidance).

**Architecture:** Two new JSON Schemas at `contracts/` define the on-disk shapes the build skill must produce (`task-meta.schema.json` for meta.yaml, `criterion-file.schema.json` for criterion `.md` frontmatter). A new Python validator `chart_review.build_skill_validator` checks a draft package against both schemas and is exposed to the skill via an MCP tool the skill calls before declaring "Done." The skill's templates (`file-templates.md`) get a parse-time audit so template drift cannot land silently. SKILL.md and interview-guide.md are updated so the skill (1) wires `derivation:` expressions for derived criteria and (2) refuses to ship `# TODO` markers.

**Tech Stack:** Python 3.11+, `jsonschema>=4.21`, pytest, TypeScript (server MCP tool), vitest for the server side.

---

## File map

**Create:**

- `contracts/task-meta.schema.json` — JSON Schema, on-disk meta.yaml
- `contracts/criterion-file.schema.json` — JSON Schema, criterion `.md` frontmatter (with conditional `if is_final_output then derivation`)
- `lib/chart_review/build_skill_validator.py` — Python validator: `validate_package(dir_path) -> Diagnostics`
- `lib/tests/contracts/__init__.py` — empty
- `lib/tests/contracts/test_task_meta_schema.py` — schema validates known-good and rejects known-bad
- `lib/tests/contracts/test_criterion_file_schema.py` — same, plus conditional rule
- `lib/tests/contracts/test_file_templates_audit.py` — parse `file-templates.md` code blocks, validate each against its target schema
- `lib/tests/contracts/test_build_skill_validator.py` — end-to-end validator on known-good and known-bad packages
- `lib/tests/fixtures/build-skill/known-good/meta.yaml`
- `lib/tests/fixtures/build-skill/known-good/references/criteria/leaf_yes_no.md`
- `lib/tests/fixtures/build-skill/known-good/references/criteria/derived_status.md`
- `lib/tests/fixtures/build-skill/known-bad-meta/meta.yaml` (B1 reproduction — the broken file from the test session)
- `lib/tests/fixtures/build-skill/known-bad-derivation/meta.yaml`
- `lib/tests/fixtures/build-skill/known-bad-derivation/references/criteria/status.md` (B4 reproduction — `is_final_output: true`, no `derivation`)
- `lib/tests/fixtures/build-skill/known-bad-todo/references/criteria/path_present.md` (A6 reproduction — body contains `# TODO confirm`)
- Modified: `app/server/builder-mcp-tools.ts` — `validate_package` tool added alongside `mark_drafted`
- Modified: `app/server/__tests__/builder-mcp-tools.test.ts` — 3 new tests added

**Modify:**

- `lib/chart_review/validator.py` — add `validate_task_meta(meta_dict, contracts_dir)` and `validate_criterion_frontmatter(fm_dict, contracts_dir)` thin wrappers that mirror the existing `validate_compiled_task` shape
- `.claude/skills/chart-review-build/SKILL.md` — Phase 7 must call `chart_review_builder.validate_package` before declaring "Done"; hard rules section gains the no-TODO and derivation-required rules
- `.claude/skills/chart-review-build/references/file-templates.md` — derivation example for `is_final_output: true` criteria; explicit no-`# TODO` rule
- `.claude/skills/chart-review-build/references/interview-guide.md` — Phase 4 sub-step: when the user wants a derived criterion, the skill asks for the combining rule and emits a `derivation:` expression

**No changes:**

- `contracts/compiled_task.schema.json` — separate concern (post-parse shape); unchanged in this cluster

---

## Task 1: Capture known-good and known-bad fixtures

**Files:**

- Create: `lib/tests/fixtures/build-skill/known-good/meta.yaml`
- Create: `lib/tests/fixtures/build-skill/known-good/references/criteria/leaf_yes_no.md`
- Create: `lib/tests/fixtures/build-skill/known-good/references/criteria/derived_status.md`
- Create: `lib/tests/fixtures/build-skill/known-bad-meta/meta.yaml`
- Create: `lib/tests/fixtures/build-skill/known-bad-derivation/meta.yaml`
- Create: `lib/tests/fixtures/build-skill/known-bad-derivation/references/criteria/status.md`
- Create: `lib/tests/fixtures/build-skill/known-bad-todo/references/criteria/path_present.md`

- [ ] **Step 1: Write the known-good meta.yaml**

```yaml
# lib/tests/fixtures/build-skill/known-good/meta.yaml
task_type: phenotype_validation
review_unit: patient
manual_version: '2026-05-07'
index_anchor: index_date
time_windows:
  - id: lookback_24mo
    anchor: index_anchor
    start_offset: -24mo
    end_offset: 0d
final_output: lung_cancer_status
overview_prose: |
  Three-tier pathology-first hierarchy for lung cancer phenotyping.
```

- [ ] **Step 2: Write a leaf criterion file**

```markdown
<!-- lib/tests/fixtures/build-skill/known-good/references/criteria/leaf_yes_no.md -->
---
field_id: lung_cancer_pathology_present
prompt: Does the pathology report document malignant lung tissue?
answer_schema:
  type: enum
  enum:
    - "yes"
    - "no"
    - "not_applicable"
is_final_output: false
---

## Definition

A pathology report (tissue biopsy, surgical specimen, or cytology) that explicitly documents malignant lung epithelial histology.

## Extraction guidance

Search clinical notes for pathology reports with specimen type = lung; report body mentioning malignancy, carcinoma, or specific lung cancer subtype.

## Examples

**Satisfying:**
- "Lung biopsy: adenocarcinoma, grade 2"

**Non-satisfying:**
- "Lung biopsy: benign hamartoma"
```

- [ ] **Step 3: Write a derived criterion file with a `derivation` expression**

```markdown
<!-- lib/tests/fixtures/build-skill/known-good/references/criteria/derived_status.md -->
---
field_id: lung_cancer_status
prompt: What is the patient's lung cancer status?
answer_schema:
  type: enum
  enum:
    - confirmed
    - probable
    - absent
is_final_output: true
derivation:
  kind: expression
  expr: |
    if lung_cancer_pathology_present == "yes" then "confirmed"
    else if lung_imaging_suspicious == "yes" and lung_cancer_clinical_mention == "yes" then "probable"
    else "absent"
---

## Definition

Final phenotype label per pathology-first hierarchy.
```

- [ ] **Step 4: Write the known-bad meta.yaml (the actual broken file from the test session, B1 repro)**

```yaml
# lib/tests/fixtures/build-skill/known-bad-meta/meta.yaml
---
name: lung-cancer-who-has-it
title: Lung Cancer Phenotyping
description: >
  Identifies patients with lung cancer.
population: All patients in corpus, no eligibility filter.
index_date_definition: Most recent chart encounter date per patient.
output_shape: outcome-first
final_output_field: lung_cancer_status
version: "0.1.0"
status: draft
```

- [ ] **Step 5: Write the known-bad derivation criterion (B4 repro)**

```yaml
# lib/tests/fixtures/build-skill/known-bad-derivation/meta.yaml
task_type: phenotype_validation
review_unit: patient
manual_version: '2026-05-07'
index_anchor: index_date
time_windows:
  - id: lookback_24mo
    anchor: index_anchor
    start_offset: -24mo
    end_offset: 0d
final_output: lung_cancer_status
overview_prose: minimal
```

```markdown
<!-- lib/tests/fixtures/build-skill/known-bad-derivation/references/criteria/status.md -->
---
field_id: lung_cancer_status
prompt: What is the patient's status?
answer_schema:
  type: enum
  enum: [confirmed, probable, absent]
is_final_output: true
---

## Definition

Final label.

## Extraction guidance

Combine the leaves: pathology=yes → confirmed; etc.
```

(Note: `is_final_output: true` but no `derivation` block. Schema must reject.)

- [ ] **Step 6: Write the known-bad TODO criterion (A6 repro)**

```markdown
<!-- lib/tests/fixtures/build-skill/known-bad-todo/references/criteria/path_present.md -->
---
field_id: lung_cancer_pathology_present
prompt: Does the pathology report document malignant lung tissue?
answer_schema:
  type: enum
  enum: ["yes", "no", "not_applicable"]
is_final_output: false
---

## Definition

A pathology report.

## Extraction guidance

Search clinical notes for:
- ICD codes: # TODO confirm lung cancer pathology codes (C34.x range)
- Procedures: # TODO confirm biopsy / specimen codes
```

- [ ] **Step 7: Commit**

```bash
git add lib/tests/fixtures/build-skill/
git commit -m "test(build-skill): add known-good + known-bad fixtures (B1 B4 A6)"
```

---

## Task 2: Author task-meta.schema.json and its tests

**Files:**

- Create: `contracts/task-meta.schema.json`
- Create: `lib/tests/contracts/__init__.py` (empty)
- Create: `lib/tests/contracts/test_task_meta_schema.py`
- Modify: `lib/chart_review/validator.py` — add `validate_task_meta` helper

- [ ] **Step 1: Write the failing test**

```python
# lib/tests/contracts/test_task_meta_schema.py
"""Schema for the on-disk meta.yaml that chart-review-build emits."""

from __future__ import annotations

import json
from pathlib import Path

import yaml
from chart_review.validator import validate_task_meta

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
FIXTURES = ROOT / "lib" / "tests" / "fixtures" / "build-skill"


def _load_yaml(p: Path) -> dict:
    return yaml.safe_load(p.read_text())


def test_known_good_meta_validates():
    meta = _load_yaml(FIXTURES / "known-good" / "meta.yaml")
    result = validate_task_meta(meta, CONTRACTS)
    assert result["status"] == "pass", result["errors"]


def test_known_bad_meta_rejected():
    """The actual broken meta.yaml from the 2026-05-07 test session must fail."""
    meta = _load_yaml(FIXTURES / "known-bad-meta" / "meta.yaml")
    result = validate_task_meta(meta, CONTRACTS)
    assert result["status"] == "fail"
    # The schema must specifically catch the missing required keys
    msg = " ".join(result["errors"])
    assert "task_type" in msg or "manual_version" in msg or "final_output" in msg


def test_unknown_keys_rejected():
    """Schema is closed: stray keys like final_output_field must fail."""
    meta = _load_yaml(FIXTURES / "known-good" / "meta.yaml")
    meta["final_output_field"] = "lung_cancer_status"  # the build-skill bug shape
    result = validate_task_meta(meta, CONTRACTS)
    assert result["status"] == "fail"
    assert "final_output_field" in " ".join(result["errors"])
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/xinghe/Downloads/Chart\ Review\ Agents/chart-review-platform/lib
python3 -m pytest tests/contracts/test_task_meta_schema.py -v
```

Expected: FAIL with `ImportError: cannot import name 'validate_task_meta'` or schema-not-found.

- [ ] **Step 3: Add the validator helper**

In `lib/chart_review/validator.py`, append:

```python
def validate_task_meta(meta: dict, contracts_dir: Path | str) -> dict:
    """Validate a parsed meta.yaml against contracts/task-meta.schema.json.

    Returns {"status": "pass"} or {"status": "fail", "errors": [str, ...]}.
    """
    contracts_dir = Path(contracts_dir)
    schema = json.loads((contracts_dir / "task-meta.schema.json").read_text())
    try:
        jsonschema.validate(instance=meta, schema=schema)
        return {"status": "pass"}
    except jsonschema.ValidationError as e:
        # collect all errors, not just the first
        validator = jsonschema.Draft202012Validator(schema)
        errors = [err.message for err in validator.iter_errors(meta)]
        return {"status": "fail", "errors": errors}
```

(The existing `validate_compiled_task` in this file is the pattern. Reuse imports already present at the top of the file.)

- [ ] **Step 4: Author the schema**

```json
// contracts/task-meta.schema.json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/task-meta.schema.json",
  "title": "TaskMeta",
  "description": "On-disk meta.yaml emitted by chart-review-build, consumed by the loader.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "task_type",
    "review_unit",
    "manual_version",
    "index_anchor",
    "time_windows",
    "final_output",
    "overview_prose"
  ],
  "properties": {
    "task_type": {
      "type": "string",
      "enum": ["phenotype_validation", "cohort_classification", "outcome_adjudication"]
    },
    "review_unit": {
      "type": "string",
      "enum": ["patient", "encounter", "episode", "event"]
    },
    "manual_version": {
      "type": "string",
      "minLength": 1
    },
    "index_anchor": {
      "type": "string",
      "minLength": 1
    },
    "time_windows": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "anchor", "start_offset", "end_offset"],
        "properties": {
          "id": { "type": "string" },
          "anchor": { "type": "string" },
          "start_offset": { "type": "string" },
          "end_offset": { "type": "string" },
          "label": { "type": "string" }
        }
      }
    },
    "final_output": {
      "type": "string",
      "description": "field_id of the criterion that holds the final answer.",
      "minLength": 1
    },
    "overview_prose": {
      "type": "string",
      "minLength": 1
    },
    "task_id": { "type": "string" },
    "denominator": { "type": "string" },
    "index_event": { "type": "string" },
    "output_shape": {
      "type": "string",
      "enum": ["outcome-first", "evidence-first", "timeline", "hybrid", "narrative"]
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
python3 -m pytest tests/contracts/test_task_meta_schema.py -v
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add contracts/task-meta.schema.json lib/chart_review/validator.py lib/tests/contracts/__init__.py lib/tests/contracts/test_task_meta_schema.py
git commit -m "feat(contracts): add task-meta.schema.json (B1)"
```

---

## Task 3: Author criterion-file.schema.json with conditional rule

**Files:**

- Create: `contracts/criterion-file.schema.json`
- Create: `lib/tests/contracts/test_criterion_file_schema.py`
- Modify: `lib/chart_review/validator.py` — add `validate_criterion_frontmatter`

- [ ] **Step 1: Write the failing test**

```python
# lib/tests/contracts/test_criterion_file_schema.py
"""Schema for the YAML frontmatter of references/criteria/<id>.md files."""

from __future__ import annotations

import re
from pathlib import Path

import yaml
from chart_review.validator import validate_criterion_frontmatter

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
FIXTURES = ROOT / "lib" / "tests" / "fixtures" / "build-skill"


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)


def _load_criterion_file(p: Path) -> tuple[dict, str]:
    """Return (frontmatter_dict, body_text) for a criterion .md file."""
    text = p.read_text()
    m = _FRONTMATTER_RE.match(text)
    assert m, f"missing frontmatter fences in {p}"
    return yaml.safe_load(m.group(1)), m.group(2)


def test_known_good_leaf_validates():
    fm, _ = _load_criterion_file(
        FIXTURES / "known-good" / "references" / "criteria" / "leaf_yes_no.md"
    )
    result = validate_criterion_frontmatter(fm, CONTRACTS)
    assert result["status"] == "pass", result["errors"]


def test_known_good_derived_validates():
    """Derived criterion (is_final_output: true) MUST have a derivation block."""
    fm, _ = _load_criterion_file(
        FIXTURES / "known-good" / "references" / "criteria" / "derived_status.md"
    )
    result = validate_criterion_frontmatter(fm, CONTRACTS)
    assert result["status"] == "pass", result["errors"]
    assert fm.get("derivation") is not None  # sanity


def test_derived_without_derivation_rejected():
    """B4: is_final_output: true with no derivation block must fail."""
    fm, _ = _load_criterion_file(
        FIXTURES / "known-bad-derivation" / "references" / "criteria" / "status.md"
    )
    result = validate_criterion_frontmatter(fm, CONTRACTS)
    assert result["status"] == "fail"
    msg = " ".join(result["errors"])
    assert "derivation" in msg


def test_leaf_without_derivation_passes():
    """is_final_output: false → derivation is optional."""
    fm = {
        "field_id": "x",
        "prompt": "y?",
        "answer_schema": {"type": "enum", "enum": ["yes", "no"]},
        "is_final_output": False,
    }
    result = validate_criterion_frontmatter(fm, CONTRACTS)
    assert result["status"] == "pass", result["errors"]
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python3 -m pytest tests/contracts/test_criterion_file_schema.py -v
```

Expected: FAIL — schema/validator missing.

- [ ] **Step 3: Add validator helper**

Append to `lib/chart_review/validator.py`:

```python
def validate_criterion_frontmatter(fm: dict, contracts_dir: Path | str) -> dict:
    """Validate criterion .md frontmatter against contracts/criterion-file.schema.json."""
    contracts_dir = Path(contracts_dir)
    schema = json.loads((contracts_dir / "criterion-file.schema.json").read_text())
    validator = jsonschema.Draft202012Validator(schema)
    errors = [err.message for err in validator.iter_errors(fm)]
    return {"status": "pass"} if not errors else {"status": "fail", "errors": errors}
```

- [ ] **Step 4: Author the schema with the conditional rule**

```json
// contracts/criterion-file.schema.json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/criterion-file.schema.json",
  "title": "CriterionFile",
  "description": "YAML frontmatter shape for references/criteria/<id>.md files.",
  "type": "object",
  "required": ["field_id", "prompt", "answer_schema"],
  "properties": {
    "field_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]*$"
    },
    "prompt": {
      "type": "string",
      "minLength": 1
    },
    "answer_schema": {
      "type": "object",
      "description": "Type and (optional) enum for the answer."
    },
    "is_final_output": { "type": "boolean" },
    "cardinality": { "type": "string", "enum": ["one", "many"] },
    "time_window": { "type": "string" },
    "group": { "type": "string" },
    "is_applicable_when": { "type": "string" },
    "derivation": {
      "type": "object",
      "required": ["kind", "expr"],
      "properties": {
        "kind": { "type": "string", "enum": ["expression", "rule_table"] },
        "expr": { "type": "string", "minLength": 1 }
      }
    },
    "uses": {
      "type": "object",
      "properties": {
        "code_sets": { "type": "array", "items": { "type": "string" } },
        "edge_cases": { "type": "array", "items": { "type": "string" } },
        "exemplars": { "type": "array", "items": { "type": "string" } },
        "keyword_sets": { "type": "array", "items": { "type": "string" } }
      }
    }
  },
  "allOf": [
    {
      "if": {
        "properties": { "is_final_output": { "const": true } },
        "required": ["is_final_output"]
      },
      "then": {
        "required": ["derivation"]
      }
    }
  ]
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
python3 -m pytest tests/contracts/test_criterion_file_schema.py -v
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add contracts/criterion-file.schema.json lib/chart_review/validator.py lib/tests/contracts/test_criterion_file_schema.py
git commit -m "feat(contracts): add criterion-file.schema.json with derivation conditional (B4)"
```

---

## Task 4: Add no-TODO body check (A6)

**Files:**

- Create: `lib/chart_review/build_skill_validator.py`
- Create: `lib/tests/contracts/test_build_skill_validator.py`

- [ ] **Step 1: Write the failing test**

```python
# lib/tests/contracts/test_build_skill_validator.py
"""End-to-end validator: walks a draft package and surfaces all diagnostics."""

from __future__ import annotations

from pathlib import Path

from chart_review.build_skill_validator import validate_package

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "lib" / "tests" / "fixtures" / "build-skill"


def test_known_good_package_passes():
    result = validate_package(FIXTURES / "known-good")
    assert result["ok"] is True, result["diagnostics"]


def test_known_bad_meta_caught():
    """B1: meta.yaml with skill-shape keys."""
    result = validate_package(FIXTURES / "known-bad-meta")
    assert result["ok"] is False
    codes = [d["code"] for d in result["diagnostics"]]
    assert "meta_schema_violation" in codes


def test_known_bad_derivation_caught():
    """B4: derived criterion with no derivation block."""
    result = validate_package(FIXTURES / "known-bad-derivation")
    assert result["ok"] is False
    codes = [d["code"] for d in result["diagnostics"]]
    assert "criterion_schema_violation" in codes
    msgs = " ".join(d["message"] for d in result["diagnostics"])
    assert "derivation" in msgs


def test_known_bad_todo_caught():
    """A6: # TODO marker in extraction guidance prose."""
    # known-bad-todo only has a single criterion file; build a minimal package around it
    package = FIXTURES / "known-bad-todo"
    # supply meta from known-good so meta passes, isolate the TODO failure
    result = validate_package(package, meta_override=FIXTURES / "known-good" / "meta.yaml")
    assert result["ok"] is False
    codes = [d["code"] for d in result["diagnostics"]]
    assert "todo_marker_in_body" in codes
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python3 -m pytest tests/contracts/test_build_skill_validator.py -v
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validator**

```python
# lib/chart_review/build_skill_validator.py
"""End-to-end validator for a chart-review-build skill output package.

Walks `<package>/meta.yaml` and `<package>/references/criteria/*.md`,
runs each through the relevant JSON Schema, and adds a body-prose check
that no `# TODO` markers ship in extraction guidance.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

import yaml

from chart_review.validator import (
    validate_task_meta,
    validate_criterion_frontmatter,
)

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"

_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)
_TODO_RE = re.compile(r"#\s*TODO", re.IGNORECASE)


def validate_package(
    package_dir: Path | str,
    *,
    meta_override: Optional[Path] = None,
) -> dict:
    """Validate a build-skill output package.

    Returns:
        {"ok": True, "diagnostics": []} on success
        {"ok": False, "diagnostics": [{"code": ..., "path": ..., "message": ...}]}
    """
    package_dir = Path(package_dir)
    diagnostics: list[dict] = []

    # 1. meta.yaml
    meta_path = meta_override or (package_dir / "meta.yaml")
    if not meta_path.exists():
        diagnostics.append({
            "code": "missing_meta",
            "path": str(meta_path),
            "message": "meta.yaml not found",
        })
    else:
        meta = yaml.safe_load(meta_path.read_text()) or {}
        meta_result = validate_task_meta(meta, CONTRACTS)
        if meta_result["status"] != "pass":
            for err in meta_result["errors"]:
                diagnostics.append({
                    "code": "meta_schema_violation",
                    "path": str(meta_path),
                    "message": err,
                })

    # 2. each criterion .md file
    criteria_dir = package_dir / "references" / "criteria"
    if criteria_dir.is_dir():
        for md in sorted(criteria_dir.glob("*.md")):
            text = md.read_text()
            m = _FRONTMATTER_RE.match(text)
            if not m:
                diagnostics.append({
                    "code": "missing_frontmatter",
                    "path": str(md),
                    "message": "criterion file lacks --- fences",
                })
                continue
            fm = yaml.safe_load(m.group(1)) or {}
            body = m.group(2)

            fm_result = validate_criterion_frontmatter(fm, CONTRACTS)
            if fm_result["status"] != "pass":
                for err in fm_result["errors"]:
                    diagnostics.append({
                        "code": "criterion_schema_violation",
                        "path": str(md),
                        "message": err,
                    })

            if _TODO_RE.search(body):
                diagnostics.append({
                    "code": "todo_marker_in_body",
                    "path": str(md),
                    "message": "criterion body contains a # TODO marker; resolve before shipping",
                })

    return {"ok": not diagnostics, "diagnostics": diagnostics}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python3 -m pytest tests/contracts/test_build_skill_validator.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/chart_review/build_skill_validator.py lib/tests/contracts/test_build_skill_validator.py
git commit -m "feat(validator): walk package + diagnose schema + TODO violations (B1 B4 A6)"
```

---

## Task 5: Audit file-templates.md against the schemas

**Files:**

- Create: `lib/tests/contracts/test_file_templates_audit.py`

The current template document already documents the right shape. This test catches future drift.

- [ ] **Step 1: Write the failing test**

```python
# lib/tests/contracts/test_file_templates_audit.py
"""Parse the YAML/Markdown code blocks in file-templates.md and validate them.

Catches the failure mode where the template documents one shape but the schema
requires another — drift that would let the skill ship invalid output.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml
from chart_review.validator import (
    validate_criterion_frontmatter,
    validate_task_meta,
)

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
TEMPLATES_MD = (
    ROOT
    / ".claude"
    / "skills"
    / "chart-review-build"
    / "references"
    / "file-templates.md"
)

_FENCE_RE = re.compile(
    r"```(yaml|markdown)\n(.*?)\n```",
    re.DOTALL,
)


def _extract_blocks() -> list[tuple[str, str]]:
    text = TEMPLATES_MD.read_text()
    return [(lang, body) for lang, body in _FENCE_RE.findall(text)]


def test_template_meta_validates():
    """The yaml block under '## meta.yaml' must validate against task-meta.schema.json."""
    blocks = _extract_blocks()
    yaml_blocks = [body for lang, body in blocks if lang == "yaml"]
    # Find the meta.yaml block (heuristic: contains 'task_type:')
    meta_block = next((b for b in yaml_blocks if "task_type:" in b), None)
    assert meta_block is not None, "no meta.yaml template block found"
    # The template uses placeholder values like '<task_id>'; substitute defaults that pass schema
    rendered = (
        meta_block
        .replace("<task_id>", "demo")
        .replace("<outcome-first | evidence-first | timeline | hybrid | narrative>", "outcome-first")
        .replace("<2-3 paragraph synthesis of what the chart review answers>", "Demo overview prose.")
        .replace("<who is in scope>", "all patients")
        .replace("<the anchor event, e.g. 'MI hospitalization discharge'>", "demo index event")
        .replace("<name_kebab>", "lookback_24mo")
        .replace("<human description, e.g. '30 days post discharge'>", "24-month lookback")
        .replace("<field_id_for_main_outcome>", "demo_status")
    )
    # The template doesn't include start_offset/end_offset in time_windows by default; the schema requires them
    # If the test fails on this, the template needs updating (Task 7)
    parsed = yaml.safe_load(rendered)
    result = validate_task_meta(parsed, CONTRACTS)
    assert result["status"] == "pass", (
        f"file-templates.md meta.yaml block fails task-meta schema: {result['errors']}"
    )


def test_template_criterion_frontmatter_validates():
    """The markdown criterion template must produce frontmatter that validates."""
    blocks = _extract_blocks()
    md_blocks = [body for lang, body in blocks if lang == "markdown"]
    crit_block = next((b for b in md_blocks if "field_id:" in b), None)
    assert crit_block is not None, "no criterion template block found"

    # Extract frontmatter from the template, substitute placeholders
    fm_match = re.match(r"^---\n(.*?)\n---", crit_block, re.DOTALL)
    assert fm_match, "no --- fences in criterion template"
    rendered = (
        fm_match.group(1)
        .replace("<field_id>", "demo_field")
        .replace("<one sentence question>", "Is X documented?")
        .replace("<id_from_meta.time_windows>", "lookback_24mo")
        .replace("<group_label>", "evidence")
        .replace("<DSL expression>", "true")
        .replace("<code_set_id>", "demo_codes")
        .replace("<edge_case_id>", "demo_edge")
        .replace("<exemplar_id>", "demo_exemplar")
    )
    parsed = yaml.safe_load(rendered)
    result = validate_criterion_frontmatter(parsed, CONTRACTS)
    assert result["status"] == "pass", (
        f"file-templates.md criterion frontmatter fails schema: {result['errors']}"
    )
```

- [ ] **Step 2: Run test to verify it fails or passes**

```bash
python3 -m pytest tests/contracts/test_file_templates_audit.py -v
```

The current template **may already pass** — the bug isn't that the template is wrong, it's that the skill doesn't follow it. If this test passes immediately, that's a green-bar with no fix needed; commit it as a regression guard. If it fails, fix the template in Task 7 below and re-run here.

- [ ] **Step 3: Commit**

```bash
git add lib/tests/contracts/test_file_templates_audit.py
git commit -m "test(build-skill): audit file-templates.md blocks against schemas"
```

---

## Task 6: Expose validator as MCP tool

**Files:**

- Modified: `app/server/builder-mcp-tools.ts` — `validate_package` tool added alongside `mark_drafted`
- Modified: `app/server/__tests__/builder-mcp-tools.test.ts` — 3 new tests added

- [ ] **Step 1: Write the failing test**

```typescript
// app/server/__tests__/builder-mcp-tools.test.ts (new tests appended to existing file)
import { describe, expect, it } from "vitest";
import { validateBuildPackage } from "../builder-mcp-tools";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(ROOT, "lib/tests/fixtures/build-skill");

describe("validateBuildPackage MCP tool", () => {
  it("returns ok=true for known-good", async () => {
    const r = await validateBuildPackage({
      package_dir: path.join(FIXTURES, "known-good"),
    });
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toEqual([]);
  });

  it("flags meta_schema_violation for the test-session bad meta", async () => {
    const r = await validateBuildPackage({
      package_dir: path.join(FIXTURES, "known-bad-meta"),
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "meta_schema_violation")).toBe(true);
  });

  it("flags missing derivation for derived criterion", async () => {
    const r = await validateBuildPackage({
      package_dir: path.join(FIXTURES, "known-bad-derivation"),
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "criterion_schema_violation")).toBe(true);
  });

  it("flags TODO markers in extraction guidance body", async () => {
    const r = await validateBuildPackage({
      package_dir: path.join(FIXTURES, "known-bad-todo"),
      meta_override: path.join(FIXTURES, "known-good", "meta.yaml"),
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "todo_marker_in_body")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/xinghe/Downloads/Chart\ Review\ Agents/chart-review-platform/app
npm test -- builder-mcp-tools
```

Expected: FAIL — `validateBuildPackage` not exported.

- [ ] **Step 3: Implement the MCP tool**

```typescript
// app/server/builder-mcp-tools.ts (validate_package tool added alongside mark_drafted)
/**
 * Build-skill validation MCP tool.
 *
 * Wraps the Python validator in lib/chart_review/build_skill_validator.py.
 * The skill calls this before declaring "Done" with its draft package; the
 * skill must iterate until ok=true.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");

export type Diagnostic = {
  code:
    | "missing_meta"
    | "meta_schema_violation"
    | "missing_frontmatter"
    | "criterion_schema_violation"
    | "todo_marker_in_body";
  path: string;
  message: string;
};

export type ValidateBuildPackageResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
};

export async function validateBuildPackage(args: {
  package_dir: string;
  meta_override?: string;
}): Promise<ValidateBuildPackageResult> {
  const script = `
import json, sys
from chart_review.build_skill_validator import validate_package
from pathlib import Path
kwargs = {}
if len(sys.argv) > 2:
    kwargs["meta_override"] = Path(sys.argv[2])
print(json.dumps(validate_package(Path(sys.argv[1]), **kwargs)))
`.trim();

  const argv = [
    "-c",
    script,
    args.package_dir,
    ...(args.meta_override ? [args.meta_override] : []),
  ];
  const result = spawnSync("python3", argv, {
    cwd: path.join(ROOT, "lib"),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `validateBuildPackage: python3 exited ${result.status}: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/xinghe/Downloads/Chart\ Review\ Agents/chart-review-platform/app
npm test -- builder-mcp-tools
```

Expected: 4 passed.

- [ ] **Step 5: Register the tool**

In `app/server/adapters/mcp/index.ts`, add the tool registration. Locate where existing builder MCP tools are registered (e.g. `chart_review_builder.set_phase_status`); add `chart_review_builder.validate_package`:

```typescript
// add near the existing chart_review_builder tools
server.tool(
  "chart_review_builder.validate_package",
  {
    description:
      "Validate a draft build-skill output package against task-meta and criterion-file schemas. Call before declaring 'Done'. Iterate until ok=true.",
    inputSchema: {
      type: "object",
      properties: {
        package_dir: { type: "string", description: "Absolute path to the package root." },
        meta_override: { type: "string", description: "Optional alternate meta.yaml path." },
      },
      required: ["package_dir"],
    },
  },
  async (args) => validateBuildPackage(args as any),
);
```

(Exact registration shape depends on existing patterns in `index.ts` — adjust to match.)

- [ ] **Step 6: Commit**

```bash
git add app/server/builder-mcp-tools.ts app/server/__tests__/builder-mcp-tools.test.ts
git commit -m "feat(mcp): expose chart_review_builder.validate_package (B1 B4 A6)"
```

---

## Task 7: Update file-templates.md — derivation example + no-TODO rule

**Files:**

- Modify: `.claude/skills/chart-review-build/references/file-templates.md`

- [ ] **Step 1: Read the current file**

```bash
cat .claude/skills/chart-review-build/references/file-templates.md | head -150
```

- [ ] **Step 2: Add derivation example to the criterion template**

Locate the "## `references/criteria/<field_id>.md`" section. Append after the leaf-criterion template:

````markdown
### Derived criterion (`is_final_output: true`)

When a criterion's value is computed from other criteria, you MUST emit a
`derivation` block — describing the rule in prose only is not enough. The
loader uses `derivation.expr` to roll up; without it, the agent answers the
field directly and may contradict the rule.

```markdown
---
field_id: lung_cancer_status
prompt: What is the patient's lung cancer status?
answer_schema:
  type: enum
  enum: [confirmed, probable, absent]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if lung_cancer_pathology_present == "yes" then "confirmed"
    else if lung_imaging_suspicious == "yes" and lung_cancer_clinical_mention == "yes" then "probable"
    else "absent"
---

## Definition

Final phenotype label per the pathology-first hierarchy.
```
````

- [ ] **Step 3: Add the "no TODO markers" rule**

In the "Critical rules for criterion files" list (after the markdown-fences rule), append:

```markdown
2. **No `# TODO` placeholders in body prose.** If the skill cannot resolve a
   reference (e.g. exact ICD-10 codes for a less-common condition), it MUST
   emit an explicit `open_questions:` array on the frontmatter rather than
   leaving `# TODO confirm` markers in extraction guidance. Pre-flight
   (cluster 6) and the build-skill validator both reject `# TODO` markers.
```

- [ ] **Step 4: Add a meta.yaml note about required fields**

Locate the "## meta.yaml" section. After the existing template, append:

```markdown
### Required fields

The following keys are required and validated by `task-meta.schema.json`:

- `task_type`, `review_unit`, `manual_version`
- `index_anchor`, `time_windows[]` (each with id/anchor/start_offset/end_offset)
- `final_output` (must be the field_id of a criterion in `references/criteria/`)
- `overview_prose`

Do not emit `final_output_field`, `index_date_definition`, `population`, or
`status` — those are skill-internal names that the loader does not read.
```

- [ ] **Step 5: Run the file-templates audit test**

```bash
cd lib && python3 -m pytest tests/contracts/test_file_templates_audit.py -v
```

Expected: 2 passed (the audit test from Task 5 confirms the updated template still validates).

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/chart-review-build/references/file-templates.md
git commit -m "docs(build-skill): document derivation requirement + no-TODO rule (B4 A6)"
```

---

## Task 8: Update SKILL.md — Phase 7 must call validator

**Files:**

- Modify: `.claude/skills/chart-review-build/SKILL.md`

- [ ] **Step 1: Read the current Phase 7 (artifact emission) section**

```bash
grep -n "Phase 7\|## Output\|## Procedure\|Hard rules" .claude/skills/chart-review-build/SKILL.md | head
```

- [ ] **Step 2: Add the validation step to Phase 7**

Locate the artifact-emission step (the one that says "Write the YAML at the end"). Append:

```markdown
### Validation gate

After writing all files, call `chart_review_builder.validate_package` with
the package directory. If `ok` is false, do NOT declare "Done" — read each
diagnostic, fix the file, and re-run validation. Iterate until `ok: true`.

A run with diagnostics is not a successful build; it's a half-finished one.
The user sees a "Done" message and assumes the package is loadable, then
hits ENOENT or a blank Studio page two clicks later.
```

- [ ] **Step 3: Add the hard rules**

In the Hard Rules section (or create one if absent — match the format used in
`chart-review-improve/SKILL.md`):

```markdown
## Hard rules

- **Every criterion with `is_final_output: true` MUST have a `derivation:` block.**
  Why: the loader uses the derivation expression to compute the rollup; without
  it the agent answers the field directly and can contradict the prose rule.
  How to apply: in Phase 4, when the user wants a derived criterion, ask for the
  combining rule and emit `derivation.expr` — never describe the rule only in
  extraction-guidance prose.

- **Never emit `# TODO` markers in criterion body prose.** Why: the marker
  ships as authoritative content; reviewers miss it. How to apply: if the
  skill cannot resolve a reference (e.g. specific code sets for a rare
  condition), emit an explicit `open_questions:` array on the criterion's
  frontmatter — visible to Author pre-flight, impossible to ship past LOCK.

- **Validate before declaring Done.** Why: the package must validate against
  task-meta.schema.json + criterion-file.schema.json; otherwise Studio renders
  blank and TRY fails. How to apply: call
  `chart_review_builder.validate_package` after the last file write; iterate
  on diagnostics until `ok: true`.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/chart-review-build/SKILL.md
git commit -m "feat(build-skill): require validation gate + derivation + no-TODO (B1 B4 A6)"
```

---

## Task 9: Update interview-guide.md — Phase 4 derivation sub-step

**Files:**

- Modify: `.claude/skills/chart-review-build/references/interview-guide.md`

- [ ] **Step 1: Locate Phase 4 (Criteria) in the interview guide**

```bash
grep -n "Phase 4\|criteria\b" .claude/skills/chart-review-build/references/interview-guide.md | head
```

- [ ] **Step 2: Add the derivation sub-step**

After the existing Phase 4 atomic-decomposition discussion, insert:

```markdown
### Phase 4.5 — Wiring derivations

When the user proposes a criterion that's derived from others (the "final
output" or any rollup), ask for the combining rule explicitly:

> "How should `<field_id>` be computed from the leaves? For example: 'if
> pathology_present == yes → confirmed; else if imaging + clinical → probable;
> else absent.'"

Convert the answer to a `derivation` block:

```yaml
derivation:
  kind: expression
  expr: |
    if pathology_present == "yes" then "confirmed"
    else if imaging_suspicious == "yes" and clinical_mention == "yes" then "probable"
    else "absent"
```

Do NOT skip this step — describing the combining rule only in extraction
guidance prose causes the loader to classify the criterion as a leaf and the
agent to answer it directly, which can contradict the rule.

If the user can't articulate a clean rule, that's a strong signal the
decomposition is wrong; offer to revisit Phase 4 atomicity.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/chart-review-build/references/interview-guide.md
git commit -m "docs(build-skill): Phase 4 sub-step for derivation expressions (B4)"
```

---

## Task 10: Smoke-test on the actual broken draft

**Files:**

- (no code change; validation pass on real artifact)

- [ ] **Step 1: Run validator against the test-session's broken draft**

```bash
cd lib
python3 -c "
from chart_review.build_skill_validator import validate_package
from pathlib import Path
import json
r = validate_package('/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/.claude/skills/drafts/chart-review-lung-cancer-who-has-it')
print(json.dumps(r, indent=2))
"
```

Expected: `ok: false` with diagnostics covering meta_schema_violation (B1), criterion_schema_violation for the status criterion (B4), and todo_marker_in_body for at least one criterion (A6).

- [ ] **Step 2: Document the smoke output in the PR description**

Capture the JSON output and paste it into the PR description as evidence that the validator catches the actual real-world failure case. The PR description should include:

> "Before this PR: Studio rendered blank for `lung-cancer-who-has-it` because the build skill emitted a meta.yaml the loader couldn't read. After this PR: the validator surfaces the exact diagnostics (3 meta_schema_violations, 1 criterion_schema_violation for missing derivation, 2 todo_marker_in_body), and the skill is gated from declaring 'Done' until they're resolved."

- [ ] **Step 3: No commit needed**

The smoke is a manual verification, not an artifact.

---

## Self-review checklist

- [x] **Spec coverage:** all three issues mapped to a task — B1 → Tasks 2 + 4 + 6; B4 → Tasks 1 + 3 + 4 + 9; A6 → Tasks 1 + 4 + 7 + 8.
- [x] **No placeholders:** every step has actual code or a specific file path.
- [x] **Type consistency:** `validate_package` signature consistent across Tasks 4, 6, 10. `Diagnostic` shape consistent across Python and TypeScript.
- [x] **Test framework alignment:** pytest for `lib/`, vitest for `app/`. No Playwright in this cluster (E2E lives with cluster 5/7 PRs).
- [x] **TDD discipline:** every task that adds code starts with a failing test.

---

## Acceptance

- All 10 tasks committed.
- `pytest lib/tests/contracts/ -v` passes (4 test files).
- `npm test -- builder-mcp-tools` passes.
- Running the smoke against the real broken draft (Task 10) reports the expected diagnostics.
- The build skill's SKILL.md and interview-guide.md document the new hard rules.
