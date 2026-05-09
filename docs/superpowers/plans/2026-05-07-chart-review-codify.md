# chart-review-codify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new skill that takes (locked guideline + validated cohort) and mechanically generates three families of efficiency artifacts (`keyword_sets`, `code_sets`, `note_type_filters`) attached to the locked guideline so subsequent chart-review agents can narrow their search space.

**Architecture:** Pure-Python deterministic extractor (`lib/chart_review/codify.py`) + thin TS HTTP wrapper (`app/server/codify.ts`) + LOCK-panel UI button + skill activation prose. The extractor walks `reviews/<patient>/<task>/review_state.json` files, aggregates evidence by criterion, and writes markdown-with-YAML-frontmatter artifacts to `references/{keyword_sets,code_sets}/` plus a package-level `references/note_type_filters.md`. Each artifact carries a `derived_from` block for invalidation. The criterion's `uses:` block is mutated in place to reference the new artifact IDs.

**Tech Stack:** Python 3.11+, pytest, PyYAML, jsonschema; TypeScript/Node, vitest, Express; React for the LOCK-panel button.

**Repo paths in this plan are relative to** `/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/`.

**Test commands:**
- Python: `cd lib && python3 -m pytest tests/ -v`
- TypeScript: `cd app && npm test -- --run`

**Conventions discovered during plan-writing:**
- Existing keyword_sets are **markdown files with YAML frontmatter** at `references/keyword_sets/<id>.md`. Codify outputs the same format (NOT pure `.yaml`).
- Existing keyword_set shape: `{id, description, version, terms[], synonyms{}, provenance{}}`. Codify reuses `terms[]` as the primary list and adds a `derived_from` block + `provenance.source: "codify-derived"`.
- Existing code_sets are similarly markdown-with-frontmatter at `references/code_sets/<id>.md`.
- Note-type filters do NOT have an existing convention; codify introduces the format.

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `lib/chart_review/codify.py` | Create | Pure-Python extractor: parses review_state.json, criterion .md, aggregates, ranks, writes artifacts, mutates `uses:` blocks |
| `lib/chart_review/codify_tokenizer.py` | Create | n-gram tokenizer + stopword filter (small, isolated) |
| `lib/chart_review/codify_icd_prefix.py` | Create | ICD-10 prefix-grouping helper for concept-hierarchy hints |
| `contracts/keyword_set.schema.json` | Create | JSON Schema for keyword_set frontmatter (codify-derived flavor; loose enough to also accept hand-authored ones) |
| `contracts/code_set.schema.json` | Create | JSON Schema for code_set frontmatter |
| `contracts/note_type_filters.schema.json` | Create | JSON Schema for the package-level note_type_filters file |
| `lib/tests/test_codify_tokenizer.py` | Create | Unit tests for n-gram + stopword behavior |
| `lib/tests/test_codify_icd_prefix.py` | Create | Unit tests for ICD prefix-grouping |
| `lib/tests/test_codify_extractor.py` | Create | End-to-end extractor on synthetic cohort fixture |
| `lib/tests/test_codify_uses_block.py` | Create | `uses:` block mutation: adds new IDs, doesn't remove hand-authored ones, replaces only `kw_*` / `codes_*` prefixes on re-run |
| `lib/tests/test_codify_invalidation.py` | Create | `derived_from.guideline_manual_version` set correctly; re-run with bumped version replaces artifacts |
| `lib/tests/fixtures/codify/...` | Create | Synthetic 5-patient × 4-criteria cohort + 3-criterion guideline fixture |
| `lib/chart_review/cli.py` | Modify | Add `chart-review codify --task <id>` subcommand |
| `app/server/codify.ts` | Create | TS wrapper that shells out to `python3 -m chart_review.cli codify` |
| `app/server/adapters/http/codify-routes.ts` | Create | `POST /api/guideline-codify/:taskId` |
| `app/server/server.ts` | Modify | Register the new router |
| `app/server/__tests__/codify-route.test.ts` | Create | HTTP integration test |
| `app/server/domain/rubric/phenotype-skill.ts` | Modify | Add `loadNoteTypeFilters(taskId)` helper |
| `app/server/__tests__/load-note-type-filters.test.ts` | Create | Loader test |
| `app/client/src/ui/Workspace/CodifyButton.tsx` | Create | LOCK-panel button + status |
| `app/client/src/ui/Workspace/PhaseLock.tsx` (or wherever LOCK lives) | Modify | Render `<CodifyButton />` |
| `app/client/src/__tests__/CodifyButton.test.tsx` | Create | Idle / running / stale states |
| `.claude/skills/chart-review-codify/SKILL.md` | Create | Skill activation prose |
| `.claude/skills/chart-review-codify/references/extraction-rules.md` | Create | Reference doc — when to expand a criterion's `uses:`, ID-prefix conventions |

Each task below produces a self-contained change.

---

## Task 1: Tokenizer

**Files:**
- Create: `lib/chart_review/codify_tokenizer.py`
- Create: `lib/tests/test_codify_tokenizer.py`

**Goal:** A pure function that takes a verbatim quote and returns a list of n-grams (1, 2, 3) suitable for ranking. Lowercases, strips punctuation, drops English stopwords, drops pure-numeric tokens.

- [ ] **Step 1: Write the failing tests**

Create `lib/tests/test_codify_tokenizer.py`:

```python
from chart_review.codify_tokenizer import extract_ngrams


def test_extracts_unigrams():
    ngrams = extract_ngrams("Patient has a biopsy-confirmed mass.")
    assert "biopsy" in ngrams
    assert "confirmed" in ngrams
    assert "mass" in ngrams


def test_drops_stopwords():
    ngrams = extract_ngrams("the patient and a nurse")
    assert "the" not in ngrams
    assert "and" not in ngrams
    assert "a" not in ngrams
    assert "patient" in ngrams


def test_lowercases():
    ngrams = extract_ngrams("Pathology REPORT")
    assert "pathology" in ngrams
    assert "report" in ngrams


def test_extracts_bigrams():
    ngrams = extract_ngrams("biopsy confirmed mass")
    assert "biopsy confirmed" in ngrams
    assert "confirmed mass" in ngrams


def test_extracts_trigrams():
    ngrams = extract_ngrams("ground glass opacity")
    assert "ground glass opacity" in ngrams


def test_drops_pure_numeric():
    ngrams = extract_ngrams("size 2.5 cm")
    # 2.5 is pure-numeric; cm is not
    assert "2.5" not in ngrams
    assert "cm" in ngrams


def test_strips_punctuation():
    ngrams = extract_ngrams("biopsy-confirmed, mass!")
    # hyphenated words split into components; punctuation stripped
    assert "biopsy" in ngrams
    assert "confirmed" in ngrams
    assert "mass" in ngrams
    # exclamation does NOT remain on the token
    assert "mass!" not in ngrams


def test_empty_string():
    assert extract_ngrams("") == []


def test_returns_list_of_str():
    out = extract_ngrams("hello world")
    assert isinstance(out, list)
    assert all(isinstance(t, str) for t in out)
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/test_codify_tokenizer.py -v`

Expected: 9 FAILs with `ModuleNotFoundError: No module named 'chart_review.codify_tokenizer'`.

- [ ] **Step 3: Implement the tokenizer**

Create `lib/chart_review/codify_tokenizer.py`:

```python
"""N-gram tokenizer for the codify skill.

Extracts unigrams, bigrams, and trigrams from verbatim evidence quotes.
Lowercases, strips punctuation, drops stopwords + pure-numeric tokens.
Pure function — no I/O, no global state.
"""

from __future__ import annotations

import re

# A small clinical-prose-aware stopword list. Not exhaustive — codify is a
# coverage-biased extractor; the agent filters noise at runtime.
_STOPWORDS = frozenset({
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at",
    "for", "with", "by", "from", "as", "is", "are", "was", "were", "be",
    "been", "being", "has", "have", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "this", "that", "these",
    "those", "it", "its", "if", "than", "then", "so",
})

# Word boundary: split on whitespace and any non-word/non-hyphen punctuation.
# Then strip leading/trailing hyphens. Hyphenated words ("biopsy-confirmed")
# split into separate tokens.
_TOKEN_SPLIT_RE = re.compile(r"[^\w-]+")
_NUMERIC_RE = re.compile(r"^[\d.,]+$")


def _tokenize(text: str) -> list[str]:
    """Lowercase + split + filter stopwords/numerics. Returns unigrams."""
    if not text:
        return []
    pieces = _TOKEN_SPLIT_RE.split(text.lower())
    out = []
    for p in pieces:
        # Hyphenated words: split further.
        for word in p.split("-"):
            word = word.strip()
            if not word:
                continue
            if word in _STOPWORDS:
                continue
            if _NUMERIC_RE.match(word):
                continue
            out.append(word)
    return out


def extract_ngrams(text: str) -> list[str]:
    """Return all unigrams + bigrams + trigrams from `text`.

    Bigrams and trigrams are formed from adjacent unigrams (post-stopword
    removal), so "the patient with mass" produces "patient mass" if "with"
    drops out — that's intentional, the trigram captures the clinical phrase.
    """
    unigrams = _tokenize(text)
    if not unigrams:
        return []
    bigrams = [
        f"{unigrams[i]} {unigrams[i + 1]}"
        for i in range(len(unigrams) - 1)
    ]
    trigrams = [
        f"{unigrams[i]} {unigrams[i + 1]} {unigrams[i + 2]}"
        for i in range(len(unigrams) - 2)
    ]
    return unigrams + bigrams + trigrams
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/test_codify_tokenizer.py -v`

Expected: 9 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/xinghe/Downloads/Chart\ Review\ Agents
git add chart-review-platform/lib/chart_review/codify_tokenizer.py \
        chart-review-platform/lib/tests/test_codify_tokenizer.py
git commit -m "feat(codify): n-gram tokenizer (1/2/3-grams; stopwords; punctuation; numerics)"
```

---

## Task 2: ICD prefix-grouping helper

**Files:**
- Create: `lib/chart_review/codify_icd_prefix.py`
- Create: `lib/tests/test_codify_icd_prefix.py`

**Goal:** Given a list of ICD-10-style codes, identify prefix groupings that cover ≥3 leaves of the same parent. Used to emit `prefix_hints` alongside literal codes.

- [ ] **Step 1: Write the failing tests**

Create `lib/tests/test_codify_icd_prefix.py`:

```python
from chart_review.codify_icd_prefix import group_icd_prefixes


def test_returns_empty_when_no_codes():
    assert group_icd_prefixes([]) == []


def test_returns_empty_when_below_threshold():
    # Only 2 leaves of C34 — below the ≥3 threshold.
    out = group_icd_prefixes(["C34.10", "C34.11"])
    assert out == []


def test_emits_prefix_when_three_leaves_share_parent():
    out = group_icd_prefixes(["C34.10", "C34.11", "C34.31"])
    # 3 leaves of C34 — emits the prefix.
    assert any(p["prefix"] == "C34.x" for p in out)


def test_prefix_carries_member_codes():
    out = group_icd_prefixes(["C34.10", "C34.11", "C34.31"])
    grp = next(p for p in out if p["prefix"] == "C34.x")
    assert set(grp["members"]) == {"C34.10", "C34.11", "C34.31"}


def test_does_not_emit_for_unrelated_codes():
    out = group_icd_prefixes(["C34.10", "I10", "E11.9"])
    assert out == []


def test_handles_mixed_above_and_below_threshold():
    # 3 of C34 (emit), 2 of E11 (skip), 1 of I10 (skip).
    out = group_icd_prefixes([
        "C34.10", "C34.11", "C34.31",
        "E11.9", "E11.65",
        "I10",
    ])
    prefixes = {p["prefix"] for p in out}
    assert prefixes == {"C34.x"}


def test_only_groups_dot_codes():
    # Pure-letter codes like "I10" with no dot don't have a prefix family.
    out = group_icd_prefixes(["I10", "I10", "I10", "I10"])
    assert out == []
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/test_codify_icd_prefix.py -v`

Expected: 7 FAILs.

- [ ] **Step 3: Implement the helper**

Create `lib/chart_review/codify_icd_prefix.py`:

```python
"""ICD-10 prefix-grouping for the codify skill.

When ≥3 leaves of the same parent (e.g. C34.10, C34.11, C34.31 → C34.x)
appear in a code set, emit a parent-prefix hint alongside the literals.
The agent at runtime can choose to widen its query or stay narrow.
Pure prefix grouping; no LLM, no terminology service.
"""

from __future__ import annotations

import re
from collections import defaultdict

# ICD-10 codes have the shape <letter><digits>.<digits>; we group by everything
# before the dot. Codes without a dot have no prefix family.
_ICD_LIKE_RE = re.compile(r"^([A-Z]\d+)\.")
_PREFIX_THRESHOLD = 3


def group_icd_prefixes(codes: list[str]) -> list[dict]:
    """Return prefix-grouping hints for the given list of ICD codes.

    Each hint is a dict ``{"prefix": "C34.x", "members": [<codes>]}``.
    Only emits for prefixes that have ≥3 distinct leaves in `codes`.
    Codes without a dot are ignored (no prefix family).
    """
    by_parent: dict[str, set[str]] = defaultdict(set)
    for code in codes:
        m = _ICD_LIKE_RE.match(code)
        if not m:
            continue
        by_parent[m.group(1)].add(code)
    out = []
    for parent, members in by_parent.items():
        if len(members) >= _PREFIX_THRESHOLD:
            out.append({"prefix": f"{parent}.x", "members": sorted(members)})
    out.sort(key=lambda d: d["prefix"])
    return out
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/test_codify_icd_prefix.py -v`

Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/lib/chart_review/codify_icd_prefix.py \
        chart-review-platform/lib/tests/test_codify_icd_prefix.py
git commit -m "feat(codify): ICD-10 prefix-grouping helper (≥3-leaves-of-parent threshold)"
```

---

## Task 3: Schemas for the three artifact types

**Files:**
- Create: `contracts/keyword_set.schema.json`
- Create: `contracts/code_set.schema.json`
- Create: `contracts/note_type_filters.schema.json`
- Create: `lib/tests/contracts/test_codify_schemas.py`

**Goal:** JSON Schemas for the three artifact families. Loose enough to also accept hand-authored ones (existing `imaging_findings.md` etc. should validate too); tight enough to lock the codify-derived shape.

- [ ] **Step 1: Write the schemas**

Create `contracts/keyword_set.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/keyword_set.schema.json",
  "title": "KeywordSet",
  "description": "YAML frontmatter for a references/keyword_sets/<id>.md file. Accepts both hand-authored sets and codify-derived sets.",
  "type": "object",
  "required": ["id", "terms"],
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "description": { "type": "string" },
    "version": { "type": "string" },
    "terms": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 }
    },
    "synonyms": {
      "type": "object",
      "additionalProperties": {
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "term_stats": {
      "type": "array",
      "description": "Optional per-term provenance: patient_count and total_count for codify-derived terms.",
      "items": {
        "type": "object",
        "required": ["term", "patient_count", "total_count"],
        "properties": {
          "term": { "type": "string" },
          "patient_count": { "type": "integer", "minimum": 1 },
          "total_count": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "derived_from": {
      "type": "object",
      "description": "Set by the codify skill; absent for hand-authored sets.",
      "required": ["cohort_size", "codified_at", "guideline_manual_version"],
      "properties": {
        "cohort_size": { "type": "integer", "minimum": 1 },
        "cohort_oracle_done_count": { "type": "integer", "minimum": 1 },
        "codified_at": { "type": "string" },
        "guideline_manual_version": { "type": "string" }
      }
    },
    "provenance": {
      "type": "object",
      "properties": {
        "source": { "type": "string" },
        "approved_by": { "type": "string" },
        "approved_at": { "type": "string" },
        "status": { "type": "string" }
      }
    }
  }
}
```

Create `contracts/code_set.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/code_set.schema.json",
  "title": "CodeSet",
  "description": "YAML frontmatter for a references/code_sets/<id>.md file.",
  "type": "object",
  "required": ["id", "codes"],
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "description": { "type": "string" },
    "version": { "type": "string" },
    "codes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["concept_id"],
        "properties": {
          "concept_id": { "type": ["integer", "string"] },
          "concept_name": { "type": "string" },
          "source_table": { "type": "string" },
          "code": { "type": "string" },
          "patient_count": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "prefix_hints": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["prefix", "members"],
        "properties": {
          "prefix": { "type": "string" },
          "members": {
            "type": "array",
            "items": { "type": "string" }
          },
          "patient_count": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "derived_from": {
      "type": "object",
      "required": ["cohort_size", "codified_at", "guideline_manual_version"],
      "properties": {
        "cohort_size": { "type": "integer", "minimum": 1 },
        "cohort_oracle_done_count": { "type": "integer", "minimum": 1 },
        "codified_at": { "type": "string" },
        "guideline_manual_version": { "type": "string" }
      }
    },
    "provenance": {
      "type": "object",
      "properties": {
        "source": { "type": "string" },
        "approved_by": { "type": "string" },
        "approved_at": { "type": "string" },
        "status": { "type": "string" }
      }
    }
  }
}
```

Create `contracts/note_type_filters.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/note_type_filters.schema.json",
  "title": "NoteTypeFilters",
  "description": "Per-criterion note-type priority. One file per package at references/note_type_filters.md.",
  "type": "object",
  "required": ["filters"],
  "properties": {
    "description": { "type": "string" },
    "version": { "type": "string" },
    "filters": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "high":   { "type": "array", "items": { "type": "string" } },
          "medium": { "type": "array", "items": { "type": "string" } },
          "low":    { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "derived_from": {
      "type": "object",
      "required": ["cohort_size", "codified_at", "guideline_manual_version"],
      "properties": {
        "cohort_size": { "type": "integer", "minimum": 1 },
        "cohort_oracle_done_count": { "type": "integer", "minimum": 1 },
        "codified_at": { "type": "string" },
        "guideline_manual_version": { "type": "string" }
      }
    }
  }
}
```

- [ ] **Step 2: Write tests asserting hand-authored fixtures still validate**

Create `lib/tests/contracts/test_codify_schemas.py`:

```python
"""Codify artifact schemas accept both codify-derived and hand-authored shapes."""

from __future__ import annotations

import re
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
SKILLS = ROOT / ".claude" / "skills"


def _load_schema(name: str) -> Draft202012Validator:
    schema = yaml.safe_load((CONTRACTS / name).read_text())
    return Draft202012Validator(schema)


def _parse_frontmatter(md_path: Path) -> dict:
    text = md_path.read_text()
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    assert m, f"No frontmatter fences in {md_path}"
    return yaml.safe_load(m.group(1)) or {}


def test_keyword_set_schema_accepts_hand_authored():
    """Existing imaging_findings / pathology_terms / etc. validate."""
    v = _load_schema("keyword_set.schema.json")
    candidates = list(SKILLS.glob("chart-review-*/references/keyword_sets/*.md"))
    assert candidates, "no hand-authored keyword_sets to validate against"
    for md in candidates:
        fm = _parse_frontmatter(md)
        errors = list(v.iter_errors(fm))
        assert not errors, f"{md.relative_to(ROOT)}: {[e.message for e in errors]}"


def test_keyword_set_schema_accepts_codify_derived():
    v = _load_schema("keyword_set.schema.json")
    fm = {
        "id": "kw_lung_cancer_pathology_present",
        "description": "Anchor keywords codified from cohort",
        "version": "2026-05-07",
        "terms": ["biopsy", "pathology report", "spiculated"],
        "term_stats": [
            {"term": "biopsy", "patient_count": 12, "total_count": 27},
        ],
        "derived_from": {
            "cohort_size": 18,
            "cohort_oracle_done_count": 18,
            "codified_at": "2026-05-07T18:42:00Z",
            "guideline_manual_version": "0.4.0",
        },
        "provenance": {"source": "codify-derived"},
    }
    errors = list(v.iter_errors(fm))
    assert not errors, [e.message for e in errors]


def test_code_set_schema_accepts_codify_derived():
    v = _load_schema("code_set.schema.json")
    fm = {
        "id": "codes_lung_cancer_pathology_present",
        "codes": [
            {"concept_id": 4115276, "concept_name": "Malignant tumor of lung",
             "source_table": "condition_occurrence", "patient_count": 9},
        ],
        "prefix_hints": [
            {"prefix": "C34.x", "members": ["C34.10", "C34.11", "C34.31"],
             "patient_count": 11},
        ],
        "derived_from": {
            "cohort_size": 18,
            "codified_at": "2026-05-07T18:42:00Z",
            "guideline_manual_version": "0.4.0",
        },
    }
    errors = list(v.iter_errors(fm))
    assert not errors, [e.message for e in errors]


def test_note_type_filters_schema():
    v = _load_schema("note_type_filters.schema.json")
    fm = {
        "filters": {
            "lung_cancer_pathology_present": {
                "high":   ["pathology", "oncology_consult"],
                "medium": ["discharge_summary"],
            }
        },
        "derived_from": {
            "cohort_size": 18,
            "codified_at": "2026-05-07T18:42:00Z",
            "guideline_manual_version": "0.4.0",
        },
    }
    errors = list(v.iter_errors(fm))
    assert not errors, [e.message for e in errors]
```

- [ ] **Step 3: Run schema tests**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/contracts/test_codify_schemas.py -v`

Expected: 4 PASS. The `test_keyword_set_schema_accepts_hand_authored` is the most important — confirms backward compat with `imaging_findings.md`, `pathology_terms.md`, `lung_anatomy.md`.

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/contracts/keyword_set.schema.json \
        chart-review-platform/contracts/code_set.schema.json \
        chart-review-platform/contracts/note_type_filters.schema.json \
        chart-review-platform/lib/tests/contracts/test_codify_schemas.py
git commit -m "feat(contracts): schemas for codify artifacts (keyword_set, code_set, note_type_filters)"
```

---

## Task 4: Synthetic cohort fixture

**Files:**
- Create: `lib/tests/fixtures/codify/locked-task/meta.yaml`
- Create: `lib/tests/fixtures/codify/locked-task/references/criteria/{lung_pathology,lung_imaging,age_at_index,lung_status}.md`
- Create: `lib/tests/fixtures/codify/reviews/{patient_01..05}/locked-task/review_state.json`

**Goal:** A tiny, hand-built cohort that the extractor's tests run against. 5 patients × 4 criteria, with a deterministic mix of note evidence and OMOP evidence.

- [ ] **Step 1: Create the locked-task fixture**

Create `lib/tests/fixtures/codify/locked-task/meta.yaml`:

```yaml
task_type: phenotype_validation
review_unit: patient
manual_version: '1.0.0'
status: locked
index_anchor: index_date
time_windows:
  - id: lookback_24mo
    anchor: index_anchor
    start_offset: -P24M
    end_offset: P0D
final_output: lung_status
overview_prose: Codify-skill test fixture.
```

Create `lib/tests/fixtures/codify/locked-task/references/criteria/lung_pathology.md`:

```markdown
---
field_id: lung_pathology
prompt: Is pathology positive for lung malignancy?
answer_schema:
  type: enum
  enum: [yes, no]
---

## Definition

Lung-pathology indicator.
```

Create `lib/tests/fixtures/codify/locked-task/references/criteria/lung_imaging.md`:

```markdown
---
field_id: lung_imaging
prompt: Is imaging suspicious for lung malignancy?
answer_schema:
  type: enum
  enum: [yes, no]
---

## Definition

Imaging-suspicion indicator.
```

Create `lib/tests/fixtures/codify/locked-task/references/criteria/age_at_index.md`:

```markdown
---
field_id: age_at_index
prompt: Patient age at index.
answer_schema:
  type: number
---

## Definition

Age at index date.
```

Create `lib/tests/fixtures/codify/locked-task/references/criteria/lung_status.md`:

```markdown
---
field_id: lung_status
prompt: Final lung status.
answer_schema:
  type: enum
  enum: [confirmed, probable, absent]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if lung_pathology == "yes" then "confirmed"
    else if lung_imaging == "yes" then "probable"
    else "absent"
uses:
  keyword_sets:
    - kw_hand_authored_anchor
---

## Definition

Final output.
```

(The hand-authored `kw_hand_authored_anchor` reference is a sentinel for Task 6's `uses:`-block-mutation test — codify must not remove it.)

- [ ] **Step 2: Create review_state fixtures (5 patients)**

Create the directory: `lib/tests/fixtures/codify/reviews/`

Create `lib/tests/fixtures/codify/reviews/patient_01/locked-task/review_state.json`:

```json
{
  "schema_version": "1",
  "patient_id": "patient_01",
  "task_id": "locked-task",
  "version": 5,
  "updated_at": "2026-04-29T10:00:00Z",
  "updated_by": "reviewer",
  "review_status": "reviewer_validated",
  "field_assessments": [
    {
      "field_id": "lung_pathology",
      "answer": "yes",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": [
        {
          "source": "note",
          "note_id": "patient_01__pathology_2024-11-22",
          "doc_type": "pathology",
          "span_offsets": [120, 180],
          "verbatim_quote": "Biopsy confirmed adenocarcinoma of the lung.",
          "evidence_date": "2024-11-22"
        },
        {
          "source": "omop",
          "table": "condition_occurrence",
          "row_id": "5101",
          "concept_id": 4115276,
          "concept_name": "Malignant tumor of lung",
          "value": "C34.10",
          "evidence_date": "2024-11-22"
        }
      ]
    },
    {
      "field_id": "lung_imaging",
      "answer": "yes",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": [
        {
          "source": "note",
          "note_id": "patient_01__radiology_2024-11-15",
          "doc_type": "radiology",
          "span_offsets": [50, 110],
          "verbatim_quote": "Spiculated mass in the right upper lobe.",
          "evidence_date": "2024-11-15"
        }
      ]
    },
    {
      "field_id": "age_at_index",
      "answer": 71,
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": []
    },
    {
      "field_id": "lung_status",
      "answer": "confirmed",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": []
    }
  ],
  "selected_evidence": [],
  "oracle_done": true
}
```

Create `lib/tests/fixtures/codify/reviews/patient_02/locked-task/review_state.json` with `lung_pathology: yes`, evidence quote "Pathology report shows malignant cells; biopsy confirmed.", a `condition_occurrence` row with `concept_id: 4115276 (Malignant tumor of lung)` `value: "C34.11"`, and `lung_imaging: yes` with quote "Hilar mass on imaging." Use the same JSON shape; full file:

```json
{
  "schema_version": "1",
  "patient_id": "patient_02",
  "task_id": "locked-task",
  "version": 4,
  "updated_at": "2026-04-29T10:00:00Z",
  "updated_by": "reviewer",
  "review_status": "reviewer_validated",
  "field_assessments": [
    {
      "field_id": "lung_pathology",
      "answer": "yes",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": [
        {
          "source": "note",
          "note_id": "patient_02__pathology_2024-12-01",
          "doc_type": "pathology",
          "span_offsets": [40, 100],
          "verbatim_quote": "Pathology report shows malignant cells; biopsy confirmed.",
          "evidence_date": "2024-12-01"
        },
        {
          "source": "omop",
          "table": "condition_occurrence",
          "row_id": "5102",
          "concept_id": 4115276,
          "concept_name": "Malignant tumor of lung",
          "value": "C34.11",
          "evidence_date": "2024-12-01"
        }
      ]
    },
    {
      "field_id": "lung_imaging",
      "answer": "yes",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": [
        {
          "source": "note",
          "note_id": "patient_02__radiology_2024-11-29",
          "doc_type": "radiology",
          "span_offsets": [10, 50],
          "verbatim_quote": "Hilar mass on imaging.",
          "evidence_date": "2024-11-29"
        }
      ]
    },
    {
      "field_id": "age_at_index",
      "answer": 68,
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": []
    },
    {
      "field_id": "lung_status",
      "answer": "confirmed",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": []
    }
  ],
  "selected_evidence": [],
  "oracle_done": true
}
```

Create `lib/tests/fixtures/codify/reviews/patient_03/locked-task/review_state.json`:

```json
{
  "schema_version": "1",
  "patient_id": "patient_03",
  "task_id": "locked-task",
  "version": 3,
  "updated_at": "2026-04-29T10:00:00Z",
  "updated_by": "reviewer",
  "review_status": "reviewer_validated",
  "field_assessments": [
    {
      "field_id": "lung_pathology",
      "answer": "yes",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": [
        {
          "source": "note",
          "note_id": "patient_03__pathology_2024-10-15",
          "doc_type": "pathology",
          "span_offsets": [0, 60],
          "verbatim_quote": "Biopsy of right lung mass: small cell carcinoma.",
          "evidence_date": "2024-10-15"
        },
        {
          "source": "omop",
          "table": "condition_occurrence",
          "row_id": "5103",
          "concept_id": 4115276,
          "concept_name": "Malignant tumor of lung",
          "value": "C34.31",
          "evidence_date": "2024-10-15"
        }
      ]
    },
    {
      "field_id": "lung_imaging",
      "answer": "yes",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": [
        {
          "source": "note",
          "note_id": "patient_03__radiology_2024-10-10",
          "doc_type": "radiology",
          "span_offsets": [20, 80],
          "verbatim_quote": "Right upper lobe mass, spiculated, suspicious for malignancy.",
          "evidence_date": "2024-10-10"
        }
      ]
    },
    {
      "field_id": "age_at_index",
      "answer": 75,
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": []
    },
    {
      "field_id": "lung_status",
      "answer": "confirmed",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": []
    }
  ],
  "selected_evidence": [],
  "oracle_done": true
}
```

Create `lib/tests/fixtures/codify/reviews/patient_04/locked-task/review_state.json` (negative case — `oracle_done: true` but no malignancy):

```json
{
  "schema_version": "1",
  "patient_id": "patient_04",
  "task_id": "locked-task",
  "version": 3,
  "updated_at": "2026-04-29T10:00:00Z",
  "updated_by": "reviewer",
  "review_status": "reviewer_validated",
  "field_assessments": [
    {
      "field_id": "lung_pathology",
      "answer": "no",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": []
    },
    {
      "field_id": "lung_imaging",
      "answer": "no",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": [
        {
          "source": "note",
          "note_id": "patient_04__radiology_2024-09-01",
          "doc_type": "radiology",
          "span_offsets": [0, 40],
          "verbatim_quote": "Lungs are clear. No mass identified.",
          "evidence_date": "2024-09-01"
        }
      ]
    },
    {
      "field_id": "age_at_index",
      "answer": 64,
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": []
    },
    {
      "field_id": "lung_status",
      "answer": "absent",
      "source": "reviewer",
      "status": "approved",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": []
    }
  ],
  "selected_evidence": [],
  "oracle_done": true
}
```

Create `lib/tests/fixtures/codify/reviews/patient_05/locked-task/review_state.json` — a not-yet-validated patient that the extractor MUST IGNORE:

```json
{
  "schema_version": "1",
  "patient_id": "patient_05",
  "task_id": "locked-task",
  "version": 1,
  "updated_at": "2026-04-29T10:00:00Z",
  "updated_by": "agent",
  "review_status": "agent_complete",
  "field_assessments": [
    {
      "field_id": "lung_pathology",
      "answer": "yes",
      "source": "agent",
      "status": "agent_proposed",
      "updated_at": "2026-04-29T10:00:00Z",
      "evidence": [
        {
          "source": "note",
          "note_id": "patient_05__discharge_2024-08-20",
          "doc_type": "discharge_summary",
          "span_offsets": [0, 30],
          "verbatim_quote": "AGENT_GUESS_TOKEN should not appear in artifacts.",
          "evidence_date": "2024-08-20"
        }
      ]
    }
  ],
  "selected_evidence": [],
  "oracle_done": false
}
```

The `AGENT_GUESS_TOKEN` is a sentinel — Task 5's tests assert it does NOT show up in any extracted artifact (confirms `oracle_done: false` patients are skipped).

- [ ] **Step 3: Sanity-check the fixture validates against existing schemas**

Run: `cd chart-review-platform/lib && python3 -c "
from chart_review.validator import validate_review_state
import json
from pathlib import Path
for f in Path('tests/fixtures/codify/reviews').rglob('review_state.json'):
    r = validate_review_state(json.loads(f.read_text()), Path('../contracts'))
    if r['status'] != 'pass':
        print(f, r['errors'])
        raise SystemExit(1)
print('all 5 fixtures validate')
"`

Expected: `all 5 fixtures validate`. If any errors, fix the fixture file (likely a schema-version or field-shape mismatch).

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/lib/tests/fixtures/codify/
git commit -m "test(codify): synthetic 5-patient cohort fixture (4 oracle_done + 1 agent-only)"
```

---

## Task 5: Core extractor

**Files:**
- Create: `lib/chart_review/codify.py`
- Create: `lib/tests/test_codify_extractor.py`

**Goal:** The main extractor function. Walks reviews, aggregates, ranks, and produces an in-memory artifact bundle ready for the writer (Task 6).

- [ ] **Step 1: Write the failing tests**

Create `lib/tests/test_codify_extractor.py`:

```python
from pathlib import Path

import pytest

from chart_review.codify import codify

FIX = Path(__file__).resolve().parent / "fixtures" / "codify"
LOCKED_TASK = FIX / "locked-task"
REVIEWS = FIX / "reviews"


def _run():
    return codify(package_dir=LOCKED_TASK, reviews_root=REVIEWS, task_id="locked-task")


def test_returns_three_artifact_families():
    bundle = _run()
    assert "keyword_sets" in bundle
    assert "code_sets" in bundle
    assert "note_type_filters" in bundle


def test_keyword_sets_emitted_per_criterion_with_note_evidence():
    bundle = _run()
    # lung_pathology has note evidence in 3 patients → keyword_set emitted.
    assert "kw_lung_pathology" in bundle["keyword_sets"]
    assert "kw_lung_imaging" in bundle["keyword_sets"]


def test_no_keyword_set_for_criterion_without_note_evidence():
    bundle = _run()
    # age_at_index has no evidence rows in any reviewed patient.
    assert "kw_age_at_index" not in bundle["keyword_sets"]
    # lung_status is derived; no direct evidence either.
    assert "kw_lung_status" not in bundle["keyword_sets"]


def test_keyword_terms_ranked_by_patient_count():
    bundle = _run()
    pathology_kw = bundle["keyword_sets"]["kw_lung_pathology"]
    # "biopsy" appears in patient_01 + patient_02 + patient_03 → patient_count = 3.
    biopsy = next(s for s in pathology_kw["term_stats"] if s["term"] == "biopsy")
    assert biopsy["patient_count"] == 3


def test_terms_list_matches_term_stats():
    bundle = _run()
    pathology_kw = bundle["keyword_sets"]["kw_lung_pathology"]
    assert sorted(pathology_kw["terms"]) == sorted(s["term"] for s in pathology_kw["term_stats"])


def test_excludes_agent_only_patient_evidence():
    """patient_05 is oracle_done=false; its AGENT_GUESS_TOKEN must not appear."""
    bundle = _run()
    # No keyword_set should include the sentinel token.
    for kw in bundle["keyword_sets"].values():
        for s in kw["term_stats"]:
            assert "agent_guess_token" not in s["term"].lower()


def test_excludes_evidence_from_unflagged_patients():
    """Evidence rows from agent-only patients are skipped entirely."""
    bundle = _run()
    # patient_05's discharge_summary should not contribute to any note_type_filter.
    for crit_filter in bundle["note_type_filters"]["filters"].values():
        assert "discharge_summary" not in crit_filter.get("high", [])
        assert "discharge_summary" not in crit_filter.get("medium", [])


def test_code_set_emitted_for_omop_evidence():
    bundle = _run()
    assert "codes_lung_pathology" in bundle["code_sets"]
    codes = bundle["code_sets"]["codes_lung_pathology"]["codes"]
    cids = {c["concept_id"] for c in codes}
    assert 4115276 in cids


def test_code_set_includes_icd_prefix_hint():
    """3 leaves of C34 (C34.10, C34.11, C34.31) → C34.x prefix hint."""
    bundle = _run()
    cs = bundle["code_sets"]["codes_lung_pathology"]
    assert "prefix_hints" in cs
    prefixes = {p["prefix"] for p in cs["prefix_hints"]}
    assert "C34.x" in prefixes


def test_note_type_filters_assigned_per_criterion():
    bundle = _run()
    f = bundle["note_type_filters"]["filters"]
    # lung_pathology evidence came from 3/4 oracle_done patients → ≥80% threshold? 75% — medium.
    # lung_imaging evidence came from 4/4 oracle_done patients → 100% — high.
    lp = f.get("lung_pathology", {})
    li = f.get("lung_imaging", {})
    assert "pathology" in (lp.get("high", []) + lp.get("medium", []))
    assert "radiology" in (li.get("high", []) + li.get("medium", []))


def test_derived_from_block_set_on_every_artifact():
    bundle = _run()
    for kw in bundle["keyword_sets"].values():
        assert kw["derived_from"]["guideline_manual_version"] == "1.0.0"
        assert kw["derived_from"]["cohort_size"] == 4  # 4 oracle_done patients
        assert "codified_at" in kw["derived_from"]
    for cs in bundle["code_sets"].values():
        assert cs["derived_from"]["cohort_size"] == 4
    assert bundle["note_type_filters"]["derived_from"]["cohort_size"] == 4


def test_refuses_empty_cohort(tmp_path):
    """No oracle_done patients → raise."""
    empty_reviews = tmp_path / "reviews"
    empty_reviews.mkdir()
    with pytest.raises(ValueError, match="no validated patients"):
        codify(package_dir=LOCKED_TASK, reviews_root=empty_reviews, task_id="locked-task")
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/test_codify_extractor.py -v`

Expected: ImportError on `from chart_review.codify import codify`.

- [ ] **Step 3: Implement the extractor**

Create `lib/chart_review/codify.py`:

```python
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


def _read_criteria(package_dir: Path) -> list[dict]:
    out = []
    crit_dir = package_dir / "references" / "criteria"
    if not crit_dir.is_dir():
        return out
    for md in sorted(crit_dir.glob("*.md")):
        text = md.read_text()
        m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
        if not m:
            continue
        fm = yaml.safe_load(m.group(1)) or {}
        out.append(fm)
    return out


def _list_validated_reviews(reviews_root: Path, task_id: str) -> list[dict]:
    """Walk reviews_root for review_state.json files at <patient>/<task_id>/.

    Filter to oracle_done == true AND review_status in {reviewer_validated, locked}.
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
        if not rs.get("oracle_done"):
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
        reviews_root: usually <repo>/chart-review-platform/reviews/
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
                    code_patients, note_type_patients, note_metadata,
                )
        # Walk free-floating selected_evidence — only count entries that
        # carry a field_id (otherwise we can't attribute them).
        for sev in rs.get("selected_evidence", []):
            fid = sev.get("field_id")
            if not fid:
                continue
            ev = sev.get("evidence", {})
            _accumulate_evidence(
                ev, fid, pid, kw_patients, kw_total,
                code_patients, note_type_patients, note_metadata,
            )

    now = _dt.datetime.now(_dt.timezone.utc).isoformat()
    derived_from_base = {
        "cohort_size": cohort_size,
        "cohort_oracle_done_count": cohort_size,
        "codified_at": now,
        "guideline_manual_version": manual_version,
    }

    keyword_sets = _build_keyword_sets(kw_patients, kw_total, derived_from_base)
    code_sets = _build_code_sets(code_patients, derived_from_base)
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
        existing = code_patients[fid].get(cid)
        if existing is None:
            code_patients[fid][cid] = {
                "concept_id": cid,
                "concept_name": ev.get("concept_name", ""),
                "source_table": ev.get("table", ""),
                "code": str(ev.get("value", "")) if ev.get("value") is not None else "",
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


def _build_code_sets(code_patients, derived_from_base) -> dict[str, dict]:
    out = {}
    for fid, codes in code_patients.items():
        if not codes:
            continue
        rows = []
        all_codes_for_prefix: list[str] = []
        for cid, entry in codes.items():
            rows.append({
                "concept_id": cid,
                "concept_name": entry["concept_name"],
                "source_table": entry["source_table"],
                "code": entry["code"],
                "patient_count": len(entry["patient_set"]),
            })
            if entry["code"]:
                all_codes_for_prefix.append(entry["code"])
        rows.sort(key=lambda r: (-r["patient_count"], r["concept_id"]))
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
    }
```

- [ ] **Step 4: Run extractor tests**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/test_codify_extractor.py -v`

Expected: 12 PASS.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/lib/chart_review/codify.py \
        chart-review-platform/lib/tests/test_codify_extractor.py
git commit -m "feat(codify): core extractor — keyword_sets, code_sets, note_type_filters"
```

---

## Task 6: Writer + `uses:` block mutation

**Files:**
- Modify: `lib/chart_review/codify.py` (add `write_artifacts()` + `update_uses_blocks()`)
- Create: `lib/tests/test_codify_writer.py`
- Create: `lib/tests/test_codify_uses_block.py`

**Goal:** Serialize the in-memory bundle to markdown-with-frontmatter files at the canonical paths, and update each criterion's `uses.keyword_sets[]` / `uses.code_sets[]` arrays. Idempotent (re-run replaces only `kw_*` / `codes_*` entries; preserves hand-authored ones).

- [ ] **Step 1: Write writer tests**

Create `lib/tests/test_codify_writer.py`:

```python
import shutil
from pathlib import Path

import yaml

from chart_review.codify import codify, write_artifacts


FIX = Path(__file__).resolve().parent / "fixtures" / "codify"


def _setup(tmp_path):
    pkg = tmp_path / "package"
    shutil.copytree(FIX / "locked-task", pkg)
    bundle = codify(
        package_dir=pkg,
        reviews_root=FIX / "reviews",
        task_id="locked-task",
    )
    return pkg, bundle


def test_writes_keyword_set_md_files(tmp_path):
    pkg, bundle = _setup(tmp_path)
    written = write_artifacts(package_dir=pkg, bundle=bundle)
    kw_dir = pkg / "references" / "keyword_sets"
    assert (kw_dir / "kw_lung_pathology.md").is_file()
    assert (kw_dir / "kw_lung_imaging.md").is_file()
    assert any("kw_lung_pathology.md" in str(p) for p in written)


def test_writes_code_set_md_files(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    cs_dir = pkg / "references" / "code_sets"
    assert (cs_dir / "codes_lung_pathology.md").is_file()


def test_writes_note_type_filters_file(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    f = pkg / "references" / "note_type_filters.md"
    assert f.is_file()


def test_written_files_have_yaml_frontmatter(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    text = (pkg / "references" / "keyword_sets" / "kw_lung_pathology.md").read_text()
    assert text.startswith("---\n")
    assert "\n---\n" in text
    fm = yaml.safe_load(text.split("---\n")[1])
    assert fm["id"] == "kw_lung_pathology"
    assert "biopsy" in fm["terms"]


def test_re_run_is_idempotent_on_clean_inputs(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    first = (pkg / "references" / "keyword_sets" / "kw_lung_pathology.md").read_text()
    # Re-run with the SAME bundle (so codified_at differs, but everything else
    # is identical).
    write_artifacts(package_dir=pkg, bundle=bundle)
    second = (pkg / "references" / "keyword_sets" / "kw_lung_pathology.md").read_text()
    # Strip the codified_at line for the comparison (it's the only timestamp).
    def strip_ts(s):
        return "\n".join(line for line in s.splitlines() if "codified_at" not in line)
    assert strip_ts(first) == strip_ts(second)
```

Create `lib/tests/test_codify_uses_block.py`:

```python
import re
import shutil
from pathlib import Path

import yaml

from chart_review.codify import codify, write_artifacts, update_uses_blocks


FIX = Path(__file__).resolve().parent / "fixtures" / "codify"


def _setup(tmp_path):
    pkg = tmp_path / "package"
    shutil.copytree(FIX / "locked-task", pkg)
    bundle = codify(
        package_dir=pkg,
        reviews_root=FIX / "reviews",
        task_id="locked-task",
    )
    return pkg, bundle


def _read_frontmatter(md_path: Path) -> dict:
    text = md_path.read_text()
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    return yaml.safe_load(m.group(1))


def test_adds_kw_id_to_criterion_uses(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    update_uses_blocks(package_dir=pkg, bundle=bundle)
    fm = _read_frontmatter(pkg / "references" / "criteria" / "lung_pathology.md")
    assert "kw_lung_pathology" in fm.get("uses", {}).get("keyword_sets", [])


def test_adds_codes_id_to_criterion_uses(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    update_uses_blocks(package_dir=pkg, bundle=bundle)
    fm = _read_frontmatter(pkg / "references" / "criteria" / "lung_pathology.md")
    assert "codes_lung_pathology" in fm.get("uses", {}).get("code_sets", [])


def test_preserves_hand_authored_uses(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    update_uses_blocks(package_dir=pkg, bundle=bundle)
    # lung_status had a sentinel kw_hand_authored_anchor in its uses.
    fm = _read_frontmatter(pkg / "references" / "criteria" / "lung_status.md")
    kws = fm.get("uses", {}).get("keyword_sets", [])
    assert "kw_hand_authored_anchor" in kws


def test_re_run_replaces_only_codify_prefixed_ids(tmp_path):
    """Second call with a different bundle replaces only kw_* / codes_* entries."""
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    update_uses_blocks(package_dir=pkg, bundle=bundle)
    # Append a hand-authored kw to lung_pathology (simulating a manual edit between runs).
    crit = pkg / "references" / "criteria" / "lung_pathology.md"
    text = crit.read_text()
    text2 = text.replace(
        "uses:\n  keyword_sets:\n    - kw_lung_pathology",
        "uses:\n  keyword_sets:\n    - kw_lung_pathology\n    - kw_my_hand_anchor",
    )
    # If the criterion didn't have a uses block to start, add one.
    if text == text2:
        # The first run added uses; we can edit. Re-read and try a different anchor.
        fm_text_match = re.match(r"^(---\n.*?\n---\n)(.*)$", text, re.DOTALL)
        assert fm_text_match
        fm = yaml.safe_load(fm_text_match.group(1).strip("-").strip())
        fm.setdefault("uses", {}).setdefault("keyword_sets", []).append("kw_my_hand_anchor")
        new_fm = yaml.safe_dump(fm, sort_keys=False)
        crit.write_text(f"---\n{new_fm}---\n{fm_text_match.group(2)}")
    # Now re-run codify (a fresh bundle produces the same kw_lung_pathology
    # but should NOT remove kw_my_hand_anchor).
    bundle2 = codify(
        package_dir=pkg,
        reviews_root=FIX / "reviews",
        task_id="locked-task",
    )
    write_artifacts(package_dir=pkg, bundle=bundle2)
    update_uses_blocks(package_dir=pkg, bundle=bundle2)
    fm_after = _read_frontmatter(crit)
    kws = fm_after.get("uses", {}).get("keyword_sets", [])
    assert "kw_my_hand_anchor" in kws
    assert "kw_lung_pathology" in kws
```

- [ ] **Step 2: Run failing tests**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/test_codify_writer.py tests/test_codify_uses_block.py -v`

Expected: ImportErrors on `write_artifacts` / `update_uses_blocks`.

- [ ] **Step 3: Implement writer + uses-block mutator**

Append to `lib/chart_review/codify.py`:

```python


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
    codify_prefix: str,
) -> list[str]:
    """Add new_codify_id; replace any prior id with the same prefix; preserve others."""
    existing = existing or []
    out = [eid for eid in existing if not eid.startswith(codify_prefix)]
    if new_codify_id not in out:
        out.append(new_codify_id)
    # Preserve previously codify-derived ids that aren't in the new bundle —
    # the caller decides whether to remove them. (For now, drop them: a new
    # cohort run is a clean replacement of the codify-derived layer for the
    # criterion.)
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
            merged = _merge_uses_array(existing_kws, new_kw, codify_prefix="kw_")
            if merged != existing_kws:
                uses["keyword_sets"] = merged
                changed = True

        if new_cs is not None:
            uses = fm.setdefault("uses", {})
            existing_css = uses.get("code_sets")
            merged = _merge_uses_array(existing_css, new_cs, codify_prefix="codes_")
            if merged != existing_css:
                uses["code_sets"] = merged
                changed = True

        if changed:
            new_fm_yaml = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True)
            md.write_text(f"{open_fence}{new_fm_yaml.rstrip()}{close_fence}{body}")
            modified.append(md)

    return modified
```

- [ ] **Step 4: Run writer + uses-block tests**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/test_codify_writer.py tests/test_codify_uses_block.py -v`

Expected: 9 PASS (5 writer + 4 uses-block).

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/lib/chart_review/codify.py \
        chart-review-platform/lib/tests/test_codify_writer.py \
        chart-review-platform/lib/tests/test_codify_uses_block.py
git commit -m "feat(codify): writer + uses-block mutator (preserves hand-authored entries)"
```

---

## Task 7: Invalidation test

**Files:**
- Create: `lib/tests/test_codify_invalidation.py`

**Goal:** A test that codifies once at version `1.0.0`, bumps the guideline's `manual_version` to `1.1.0`, codifies again, and asserts the artifacts now carry the new version in `derived_from`.

- [ ] **Step 1: Write the test**

Create `lib/tests/test_codify_invalidation.py`:

```python
import re
import shutil
from pathlib import Path

import yaml

from chart_review.codify import codify, write_artifacts


FIX = Path(__file__).resolve().parent / "fixtures" / "codify"


def _read_frontmatter(md_path: Path) -> dict:
    text = md_path.read_text()
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    return yaml.safe_load(m.group(1))


def test_derived_from_carries_current_manual_version(tmp_path):
    pkg = tmp_path / "package"
    shutil.copytree(FIX / "locked-task", pkg)
    bundle = codify(package_dir=pkg, reviews_root=FIX / "reviews", task_id="locked-task")
    assert bundle["guideline_manual_version"] == "1.0.0"
    write_artifacts(package_dir=pkg, bundle=bundle)
    fm = _read_frontmatter(pkg / "references" / "keyword_sets" / "kw_lung_pathology.md")
    assert fm["derived_from"]["guideline_manual_version"] == "1.0.0"


def test_re_run_after_version_bump_writes_new_version(tmp_path):
    pkg = tmp_path / "package"
    shutil.copytree(FIX / "locked-task", pkg)
    write_artifacts(
        package_dir=pkg,
        bundle=codify(package_dir=pkg, reviews_root=FIX / "reviews", task_id="locked-task"),
    )
    # Bump the guideline's manual_version.
    meta_path = pkg / "meta.yaml"
    meta = yaml.safe_load(meta_path.read_text())
    meta["manual_version"] = "1.1.0"
    meta_path.write_text(yaml.safe_dump(meta, sort_keys=False))
    # Re-run.
    bundle2 = codify(package_dir=pkg, reviews_root=FIX / "reviews", task_id="locked-task")
    assert bundle2["guideline_manual_version"] == "1.1.0"
    write_artifacts(package_dir=pkg, bundle=bundle2)
    fm = _read_frontmatter(pkg / "references" / "keyword_sets" / "kw_lung_pathology.md")
    assert fm["derived_from"]["guideline_manual_version"] == "1.1.0"
```

- [ ] **Step 2: Run the test**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/test_codify_invalidation.py -v`

Expected: 2 PASS.

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform/lib/tests/test_codify_invalidation.py
git commit -m "test(codify): derived_from.guideline_manual_version follows the meta.yaml bump"
```

---

## Task 8: CLI subcommand + skill activation

**Files:**
- Modify: `lib/chart_review/cli.py`
- Create: `.claude/skills/chart-review-codify/SKILL.md`
- Create: `.claude/skills/chart-review-codify/references/extraction-rules.md`

**Goal:** `python3 -m chart_review.cli codify --task <id>` runs the extractor + writer + uses-block mutation end-to-end. The SKILL.md activates the skill in conversational use.

- [ ] **Step 1: Inspect the existing CLI to learn the conventions**

Run: `head -40 chart-review-platform/lib/chart_review/cli.py`

You'll see how subcommands are registered (likely argparse subparsers).

- [ ] **Step 2: Add the codify subcommand**

In `lib/chart_review/cli.py`, locate the `main()` function (or wherever subparsers are registered) and add a `codify` subcommand. The exact integration depends on what's already there; keep the addition minimal. Sketch:

```python
# Inside main() / subparser registration:
codify_p = subparsers.add_parser("codify", help="Codify a locked guideline against its validated cohort")
codify_p.add_argument("--task", required=True, help="task_id")
codify_p.add_argument("--package-dir", default=None, help="path to .claude/skills/chart-review-<task>/")
codify_p.add_argument("--reviews-root", default=None, help="path to chart-review-platform/reviews/")
codify_p.set_defaults(func=_cmd_codify)


def _cmd_codify(args):
    from pathlib import Path
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
    import json
    print(json.dumps({
        "written_files": [str(p) for p in written],
        "modified_criteria": [str(p) for p in modified],
        "cohort_size": bundle["cohort_size"],
        "guideline_manual_version": bundle["guideline_manual_version"],
    }, indent=2))
```

If the existing CLI doesn't use argparse subparsers (it might have a different shape), add the `codify` command following the same pattern as the existing commands. Read the file first.

- [ ] **Step 3: Smoke-test the CLI on the fixture**

Run: `cd chart-review-platform/lib && python3 -c "
from pathlib import Path
import json, shutil, tempfile
from chart_review.codify import codify, write_artifacts, update_uses_blocks

with tempfile.TemporaryDirectory() as td:
    pkg = Path(td) / 'pkg'
    shutil.copytree('tests/fixtures/codify/locked-task', pkg)
    bundle = codify(package_dir=pkg, reviews_root=Path('tests/fixtures/codify/reviews'), task_id='locked-task')
    write_artifacts(package_dir=pkg, bundle=bundle)
    update_uses_blocks(package_dir=pkg, bundle=bundle)
    print('cohort_size:', bundle['cohort_size'])
    print('keyword_set ids:', sorted(bundle['keyword_sets'].keys()))
    print('code_set ids:', sorted(bundle['code_sets'].keys()))
"`

Expected: `cohort_size: 4` (4 oracle_done patients), keyword_set ids include `kw_lung_pathology` and `kw_lung_imaging`, code_set ids include `codes_lung_pathology`.

- [ ] **Step 4: Write the skill activation file**

Create `.claude/skills/chart-review-codify/SKILL.md`:

```markdown
---
name: chart-review-codify
description: >
  Generates efficiency artifacts (keyword sets, code sets, note-type filters) from
  a locked guideline + its validated cohort. Use when the user says "codify the
  artifacts", "generate keyword sets", "extract code anchors from cohort", "speed
  up the agent for next runs", or after locking a guideline and wanting to make
  subsequent agent runs cheaper. Writes to references/{keyword_sets,code_sets,note_type_filters}/
  on the locked guideline; updates each criterion's `uses:` block to reference
  the new artifacts. Composes with chart-review-improve (which produces guideline
  edit proposals; codify produces static reference artifacts) and runs
  post-lock — never modifies guideline shape.
metadata:
  author: chart-review-platform
  version: "0.1.0"
---

# Chart Review Codify

Mechanically extracts efficiency artifacts from a locked guideline + validated
cohort. The artifacts narrow the agent's search space on subsequent patients:
keyword sets seed text searches over notes; code sets seed OMOP queries;
note-type filters prioritize which notes to read first.

## When to use

- User says "codify the artifacts", "generate keyword sets", "speed up the agent",
  "extract anchors from the cohort", "regenerate codify artifacts"
- After locking a guideline, when ready to ship efficiency hints for subsequent agents
- After a revise → re-lock cycle that bumps `manual_version` (artifacts go stale)

## Inputs

- **package_dir**: `.claude/skills/chart-review-<task>/` (must have `meta.yaml` `status: locked`)
- **reviews_root**: usually `chart-review-platform/reviews/` — walked for
  `<patient>/<task>/review_state.json` files where `oracle_done == true` AND
  `review_status` ∈ {`reviewer_validated`, `locked`}
- **task_id**: matches the per-patient subdirectory

## Procedure

1. **Read the locked guideline.** `<package_dir>/meta.yaml` and
   `<package_dir>/references/criteria/*.md`. Confirm `status: locked`.

2. **Walk the validated cohort.** Filter to oracle_done + reviewer_validated/locked
   patients. Skip everything else — agent-only proposals are not ground truth.

3. **Run the extractor.** Use `chart_review.codify.codify(...)` or
   `python3 -m chart_review.cli codify --task <id>`. The extractor produces:
   - `keyword_sets/kw_<field_id>.md` — top-30 n-grams ranked by patient-coverage
   - `code_sets/codes_<field_id>.md` — OMOP concept_ids + ICD prefix hints (≥3 leaves)
   - `note_type_filters.md` — per-criterion note-type priority (high/medium/low)

4. **Update `uses:` blocks.** Add the new artifact IDs to each criterion's
   `uses.keyword_sets[]` / `uses.code_sets[]`. Hand-authored entries (those
   NOT starting with `kw_` / `codes_`) are preserved.

5. **Report to the user.** List the files written, the cohort size, and the
   guideline manual_version stamped into `derived_from`.

## Hard rules (with reasons)

- **Only oracle_done == true patients count.** Agent-proposed-but-not-validated
  evidence isn't ground truth; including it would propagate agent biases into
  the artifacts.

- **`uses:` block updates ADD; never silently DELETE hand-authored entries.**
  Codify's role is to layer derived hints on top of the reviewer's authored
  references. A hand-authored `kw_pathology_terms` entry survives codify runs.

- **Re-running with the same inputs is safe.** The `derived_from` block carries
  the cohort signature; the agent's actual output is byte-deterministic apart
  from the `codified_at` timestamp.

- **Refuse if cohort is empty.** Zero oracle_done patients → exit with
  `ValueError: no validated patients found`. Don't write empty artifacts.

- **Codify is post-lock.** Drafts (`status: draft`) shouldn't be codified —
  the artifacts would invalidate as soon as the draft revised. The skill
  doesn't enforce this hard, but the SKILL.md guidance + UI button gating
  keep the user honest.

## See also

- `references/extraction-rules.md` — when to expand a criterion's `uses:`,
  ID-prefix conventions, ICD prefix-grouping threshold rationale.
- `chart-review-improve` — produces guideline edit proposals from the same
  cohort. Codify is parallel; runs post-lock; doesn't modify guideline shape.
```

Create `.claude/skills/chart-review-codify/references/extraction-rules.md`:

```markdown
# Codify extraction rules

## ID prefix conventions

- Codify-derived keyword sets: `kw_<field_id>`
- Codify-derived code sets: `codes_<field_id>`
- Hand-authored sets use any ID that doesn't start with `kw_` or `codes_`
  (e.g., `imaging_findings`, `pathology_terms`).

The prefix is how `update_uses_blocks` decides which entries to replace
on re-run. Hand-authored entries are preserved across codify runs.

## When a criterion does NOT get a keyword/code set

- The criterion is purely derived (`is_final_output: true` with `derivation`)
  and the reviewer never overrode it. Derived criteria roll up from leaves;
  there's no direct evidence to extract from.
- The criterion is `not_applicable` for every validated patient.
- The criterion has `evidence: []` on every reviewer-touched assessment.
  Common for criteria like `age_at_index` where the answer comes from a
  structured field the reviewer didn't pin as "evidence."

In all three cases, no artifact file is written and the `uses:` block is
left unchanged for that criterion.

## ICD prefix-grouping threshold

A prefix is emitted when ≥3 distinct leaves of the same parent appear in
the cohort. The threshold trades:

- Below 3: prefix groupings would emit on noise (e.g., one patient with
  `C34.10` + another with `C34.31` would generate `C34.x` even though the
  parent isn't well-represented).
- Above 3: misses real prefix patterns in small cohorts. Three is small
  enough to fire usefully on a 5-patient pilot, large enough to avoid noise.

The threshold lives in `lib/chart_review/codify_icd_prefix.py`.

## Top-N keyword cutoff

Each criterion's keyword set is capped at top 30 ranked terms. The cutoff
is empirical: most clinical anchor sets stabilize between 20 and 40 terms;
30 is a conservative middle that keeps file sizes small without losing
dominant phrases.

The threshold lives in `lib/chart_review/codify.py`.
```

- [ ] **Step 5: Run all Python tests + skill audit**

Run: `cd chart-review-platform/lib && python3 -m pytest tests/ -v`

Expected: all previously-passing tests stay green; new codify tests (28+ total) pass.

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/lib/chart_review/cli.py \
        chart-review-platform/.claude/skills/chart-review-codify/
git commit -m "feat(codify): CLI subcommand + chart-review-codify SKILL.md activation"
```

---

## Task 9: TS HTTP route

**Files:**
- Create: `app/server/codify.ts`
- Create: `app/server/adapters/http/codify-routes.ts`
- Modify: `app/server/server.ts`
- Create: `app/server/__tests__/codify-route.test.ts`

**Goal:** `POST /api/guideline-codify/:taskId` → invokes the Python extractor and returns `{ written_files, modified_criteria, cohort_size, guideline_manual_version }` or a structured error.

- [ ] **Step 1: Write the failing route test**

Create `app/server/__tests__/codify-route.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";

import { codifyRouter } from "../adapters/http/codify-routes.js";

describe("codify route", () => {
  let tmp: string;
  let prevPlatformRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "codify-test-"));
    // Layout: <tmp>/.claude/skills/chart-review-locked-task/  +  <tmp>/reviews/...
    const skillsDir = path.join(tmp, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    cpSync(
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "..", "..", "..", "lib", "tests", "fixtures", "codify", "locked-task",
      ),
      path.join(skillsDir, "chart-review-locked-task"),
      { recursive: true },
    );
    cpSync(
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "..", "..", "..", "lib", "tests", "fixtures", "codify", "reviews",
      ),
      path.join(tmp, "reviews"),
      { recursive: true },
    );
    prevPlatformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
    process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  });

  afterEach(() => {
    if (prevPlatformRoot === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    else process.env.CHART_REVIEW_PLATFORM_ROOT = prevPlatformRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeApp() {
    const app = express();
    app.use(codifyRouter());
    return app;
  }

  it("POST /api/guideline-codify/:taskId returns success on valid task", async () => {
    const res = await request(makeApp())
      .post("/api/guideline-codify/locked-task")
      .send();
    expect(res.status).toBe(200);
    expect(res.body.cohort_size).toBe(4);
    expect(Array.isArray(res.body.written_files)).toBe(true);
    expect(res.body.written_files.some((f: string) => f.includes("kw_lung_pathology.md"))).toBe(true);
  });

  it("writes the keyword_set file to disk", async () => {
    await request(makeApp()).post("/api/guideline-codify/locked-task").send();
    const fp = path.join(
      tmp, ".claude", "skills", "chart-review-locked-task",
      "references", "keyword_sets", "kw_lung_pathology.md",
    );
    const text = readFileSync(fp, "utf8");
    expect(text).toContain("biopsy");
  });

  it("returns 400 on empty cohort", async () => {
    // Strip reviews to force the empty-cohort path.
    rmSync(path.join(tmp, "reviews"), { recursive: true, force: true });
    mkdirSync(path.join(tmp, "reviews"));
    const res = await request(makeApp())
      .post("/api/guideline-codify/locked-task")
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no validated patients/);
  });

  it("returns 404 when task package is missing", async () => {
    const res = await request(makeApp())
      .post("/api/guideline-codify/no-such-task")
      .send();
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd chart-review-platform/app && npm test -- --run codify-route 2>&1 | tail -10`

Expected: ImportError on `../adapters/http/codify-routes.js`.

- [ ] **Step 3: Implement the wrapper + route**

Create `app/server/codify.ts`:

```typescript
// app/server/codify.ts — TS wrapper that shells out to the Python extractor.

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { PLATFORM_ROOT } from "./patients.js";

export interface CodifyResult {
  written_files: string[];
  modified_criteria: string[];
  cohort_size: number;
  guideline_manual_version: string;
}

export interface CodifyError {
  error: string;
  code: "missing_task" | "empty_cohort" | "internal";
}

/**
 * Run the codify extractor for one task. Shells out to
 * `python3 -m chart_review.cli codify --task <id>`.
 */
export function runCodify(taskId: string): CodifyResult | CodifyError {
  const root = process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT;
  const packageDir = path.join(root, ".claude", "skills", `chart-review-${taskId}`);
  if (!fs.existsSync(packageDir)) {
    return { error: `task package not found: ${packageDir}`, code: "missing_task" };
  }

  const result = spawnSync(
    "python3",
    [
      "-m", "chart_review.cli", "codify",
      "--task", taskId,
      "--package-dir", packageDir,
      "--reviews-root", path.join(root, "reviews"),
    ],
    {
      cwd: path.join(root, "lib"),
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: path.join(root, "lib") },
    },
  );

  if (result.status !== 0) {
    const stderr = result.stderr || "";
    if (stderr.includes("no validated patients")) {
      return { error: stderr.trim(), code: "empty_cohort" };
    }
    return {
      error: `python3 exited ${result.status}: ${stderr.trim()}`,
      code: "internal",
    };
  }
  try {
    return JSON.parse(result.stdout) as CodifyResult;
  } catch (err) {
    return {
      error: `failed to parse python output: ${(err as Error).message}; stdout=${result.stdout}`,
      code: "internal",
    };
  }
}

export function isCodifyError(r: CodifyResult | CodifyError): r is CodifyError {
  return "error" in r;
}
```

Create `app/server/adapters/http/codify-routes.ts`:

```typescript
// app/server/adapters/http/codify-routes.ts

import { Router } from "express";

import { isCodifyError, runCodify } from "../../codify.js";

export function codifyRouter(): Router {
  const router = Router();

  router.post("/api/guideline-codify/:taskId", (req, res) => {
    const { taskId } = req.params as { taskId: string };
    if (!/^[a-z][a-z0-9-]+$/.test(taskId)) {
      return res.status(400).json({ error: "invalid taskId" });
    }
    const result = runCodify(taskId);
    if (isCodifyError(result)) {
      switch (result.code) {
        case "missing_task":
          return res.status(404).json(result);
        case "empty_cohort":
          return res.status(400).json(result);
        default:
          return res.status(500).json(result);
      }
    }
    res.json(result);
  });

  return router;
}
```

- [ ] **Step 4: Register the router**

In `app/server/server.ts`, find where routers are mounted (`app.use(...)`). Add:

```typescript
import { codifyRouter } from "./adapters/http/codify-routes.js";

// ... existing app.use calls ...
app.use(codifyRouter());
```

- [ ] **Step 5: Run tests**

Run: `cd chart-review-platform/app && npm test -- --run codify-route 2>&1 | tail -10`

Expected: 4 PASS.

- [ ] **Step 6: Run the full TS suite to verify no regressions**

Run: `cd chart-review-platform/app && npm test -- --run 2>&1 | tail -8`

Expected: prior 770 + 4 new = 774 passing, 1 skipped.

- [ ] **Step 7: Commit**

```bash
git add chart-review-platform/app/server/codify.ts \
        chart-review-platform/app/server/adapters/http/codify-routes.ts \
        chart-review-platform/app/server/server.ts \
        chart-review-platform/app/server/__tests__/codify-route.test.ts
git commit -m "feat(codify): POST /api/guideline-codify/:taskId TS route + wrapper"
```

---

## Task 10: Note-type-filters loader extension

**Files:**
- Modify: `app/server/domain/rubric/phenotype-skill.ts`
- Create: `app/server/__tests__/load-note-type-filters.test.ts`

**Goal:** Add `loadNoteTypeFilters(taskId)` to the phenotype-skill loader so the chart-review skill at runtime can read the package-level `references/note_type_filters.md` file.

- [ ] **Step 1: Write the failing test**

Create `app/server/__tests__/load-note-type-filters.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadNoteTypeFilters } from "../domain/rubric/phenotype-skill.js";

describe("loadNoteTypeFilters", () => {
  let tmp: string;
  let prevRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "ntf-"));
    prevRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
    process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    else process.env.CHART_REVIEW_PLATFORM_ROOT = prevRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty filters when the file is absent", () => {
    expect(loadNoteTypeFilters("missing")).toEqual({ filters: {} });
  });

  it("parses a present file's frontmatter", () => {
    const dir = path.join(tmp, ".claude", "skills", "chart-review-foo", "references");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "note_type_filters.md"),
      `---\nfilters:\n  pathology_present:\n    high: [pathology, oncology_consult]\n---\n# body\n`,
    );
    const out = loadNoteTypeFilters("foo");
    expect(out.filters).toBeDefined();
    expect(out.filters.pathology_present.high).toEqual(["pathology", "oncology_consult"]);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `cd chart-review-platform/app && npm test -- --run load-note-type-filters 2>&1 | tail -8`

Expected: ImportError on `loadNoteTypeFilters`.

- [ ] **Step 3: Implement the loader helper**

In `app/server/domain/rubric/phenotype-skill.ts`, add:

```typescript
export interface NoteTypeFilters {
  filters: Record<string, { high?: string[]; medium?: string[]; low?: string[] }>;
  description?: string;
  derived_from?: Record<string, unknown>;
}

/**
 * Load the package-level references/note_type_filters.md file.
 * Returns `{ filters: {} }` when the file is absent (codify hasn't run yet).
 */
export function loadNoteTypeFilters(taskId: string): NoteTypeFilters {
  const fp = path.join(phenotypeSkillDir(taskId), "references", "note_type_filters.md");
  if (!fs.existsSync(fp)) return { filters: {} };
  const fm = readFrontmatter<NoteTypeFilters>(fp);
  if (!fm) return { filters: {} };
  return { filters: fm.filters ?? {}, description: fm.description, derived_from: fm.derived_from };
}
```

(`readFrontmatter` is the existing helper in the same file.)

- [ ] **Step 4: Run tests**

Run: `cd chart-review-platform/app && npm test -- --run load-note-type-filters 2>&1 | tail -8`

Expected: 2 PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd chart-review-platform/app && npm test -- --run 2>&1 | tail -8`

Expected: 776 passing.

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/app/server/domain/rubric/phenotype-skill.ts \
        chart-review-platform/app/server/__tests__/load-note-type-filters.test.ts
git commit -m "feat(loader): loadNoteTypeFilters reads references/note_type_filters.md"
```

---

## Task 11: LOCK panel button

**Files:**
- Create: `app/client/src/ui/Workspace/CodifyButton.tsx`
- Create: `app/client/src/__tests__/CodifyButton.test.tsx`
- Modify: the existing LOCK phase component (find via `grep -rn "phaseLock\|PhaseLock" chart-review-platform/app/client/src/ui/`)

**Goal:** A button on the LOCK panel that calls `POST /api/guideline-codify/:taskId` and shows idle / running / success / error states. Stale-detection is best-effort — show a "Stale — regenerate" badge if a previous run's `derived_from.guideline_manual_version` differs from the current task's `manual_version`.

- [ ] **Step 1: Write the failing test**

Create `app/client/src/__tests__/CodifyButton.test.tsx`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CodifyButton } from "../ui/Workspace/CodifyButton";

const mockFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

describe("CodifyButton", () => {
  it("renders idle state with descriptive label", () => {
    vi.stubGlobal("fetch", mockFetch(200, {}));
    render(<CodifyButton taskId="lung-cancer-phenotype" manualVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: /codify artifacts/i })).toBeInTheDocument();
  });

  it("calls POST /api/guideline-codify/:taskId on click", async () => {
    const fetch = mockFetch(200, {
      written_files: ["kw_x.md", "codes_x.md"],
      cohort_size: 4,
      guideline_manual_version: "1.0.0",
    });
    vi.stubGlobal("fetch", fetch);
    render(<CodifyButton taskId="lung-cancer-phenotype" manualVersion="1.0.0" />);
    await userEvent.click(screen.getByRole("button", { name: /codify/i }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/guideline-codify/lung-cancer-phenotype",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("shows a success summary after a clean run", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(200, {
        written_files: ["kw_a.md", "kw_b.md", "codes_a.md"],
        cohort_size: 4,
        guideline_manual_version: "1.0.0",
      }),
    );
    render(<CodifyButton taskId="lung-cancer-phenotype" manualVersion="1.0.0" />);
    await userEvent.click(screen.getByRole("button", { name: /codify/i }));
    await waitFor(() => {
      expect(screen.getByText(/3 file/i)).toBeInTheDocument();
      expect(screen.getByText(/cohort.*4/i)).toBeInTheDocument();
    });
  });

  it("shows the empty-cohort error inline", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(400, { error: "no validated patients found", code: "empty_cohort" }),
    );
    render(<CodifyButton taskId="lung-cancer-phenotype" manualVersion="1.0.0" />);
    await userEvent.click(screen.getByRole("button", { name: /codify/i }));
    await waitFor(() => {
      expect(screen.getByText(/no validated patients/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd chart-review-platform/app && npm test -- --run CodifyButton 2>&1 | tail -10`

Expected: ImportError on `../ui/Workspace/CodifyButton`.

- [ ] **Step 3: Implement the button**

Create `app/client/src/ui/Workspace/CodifyButton.tsx`:

```typescript
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

interface CodifyButtonProps {
  taskId: string;
  manualVersion?: string;
}

interface CodifyResult {
  written_files: string[];
  modified_criteria?: string[];
  cohort_size: number;
  guideline_manual_version: string;
}

export function CodifyButton({ taskId }: CodifyButtonProps) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CodifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const r = await fetch(`/api/guideline-codify/${encodeURIComponent(taskId)}`, {
        method: "POST",
      });
      const body = await r.json();
      if (!r.ok) {
        setError(body.error ?? "codify failed");
        return;
      }
      setResult(body as CodifyResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Efficiency artifacts
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Codify keyword sets, code sets, and note-type filters from the validated cohort.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={running}
          onClick={onClick}
        >
          <Sparkles size={12} strokeWidth={1.75} />
          {running ? "Codifying…" : "Codify artifacts"}
        </Button>
      </div>

      {result && (
        <div
          role="status"
          className="rounded-md border border-[hsl(var(--sage))]/30 bg-[hsl(var(--sage))]/5 px-3 py-2 text-[12.5px] text-[hsl(var(--sage))]"
        >
          {result.written_files.length} file{result.written_files.length === 1 ? "" : "s"} written ·
          cohort {result.cohort_size} · version {result.guideline_manual_version}.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-[hsl(var(--ochre))]/40 bg-[hsl(var(--ochre))]/5 px-3 py-2 text-[12.5px] text-[hsl(var(--ochre))]"
        >
          {error}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the button into the LOCK phase component**

Find the LOCK phase component:

Run: `grep -rn "PhaseLock\|case 'LOCK'\|phase === 'LOCK'" chart-review-platform/app/client/src/ui/ | head`

Add `<CodifyButton taskId={taskId} manualVersion={task?.manual_version} />` near the other LOCK-phase actions. The exact placement depends on the existing layout; render it at the top or bottom of the LOCK panel content.

- [ ] **Step 5: Run tests**

Run: `cd chart-review-platform/app && npm test -- --run CodifyButton 2>&1 | tail -10`

Expected: 4 PASS.

- [ ] **Step 6: Run the full suite**

Run: `cd chart-review-platform/app && npm test -- --run 2>&1 | tail -8`

Expected: 780 passing.

- [ ] **Step 7: Commit**

```bash
git add -f chart-review-platform/app/client/src/ui/Workspace/CodifyButton.tsx \
           chart-review-platform/app/client/src/__tests__/CodifyButton.test.tsx
# Plus whatever LOCK-phase file you modified.
git commit -m "feat(ui): CodifyButton on LOCK panel — call POST /api/guideline-codify"
```

(`-f` because some `Workspace/` paths match a `.gitignore` `workspace/` pattern; mirror cluster 6's commit pattern.)

---

## Task 12: Smoke test on a real locked guideline

**Files:**
- Create: `chart-review-platform/docs/superpowers/specs/2026-05-07-codify-smoke-findings.md`

**Goal:** Run the codify CLI against an actual locked guideline + its real cohort. Capture: cohort size, files written, sample output. This proves the v0 works end-to-end on real data.

- [ ] **Step 1: Identify a locked guideline + cohort**

Run: `ls chart-review-platform/.claude/skills/ | grep -v drafts && echo "---" && find chart-review-platform/reviews -maxdepth 3 -name "review_state.json" 2>/dev/null | head`

Pick a task that has both a locked package AND multiple `oracle_done: true` review_state files. `lung-cancer-phenotype` is the most likely candidate.

- [ ] **Step 2: Run codify**

Run: `cd chart-review-platform/lib && python3 -m chart_review.cli codify --task lung-cancer-phenotype 2>&1 | tee /tmp/codify-smoke.json`

Expected: a JSON object with `written_files`, `modified_criteria`, `cohort_size`, `guideline_manual_version`. If `cohort_size: 0`, find a different task or accept that the cohort isn't validated yet (in which case, document that finding).

- [ ] **Step 3: Inspect the output**

Run: `ls chart-review-platform/.claude/skills/chart-review-lung-cancer-phenotype/references/keyword_sets/ && head -40 chart-review-platform/.claude/skills/chart-review-lung-cancer-phenotype/references/keyword_sets/$(ls chart-review-platform/.claude/skills/chart-review-lung-cancer-phenotype/references/keyword_sets/ | grep ^kw_ | head -1)`

Verify a `kw_*.md` file exists and has plausible terms.

- [ ] **Step 4: Re-run to confirm idempotency**

Run: `cd chart-review-platform/lib && python3 -m chart_review.cli codify --task lung-cancer-phenotype && diff /tmp/codify-smoke.json <(cd chart-review-platform/lib && python3 -m chart_review.cli codify --task lung-cancer-phenotype) | grep -v codified_at`

Expected: only `codified_at` differs between runs. If anything else differs, that's a non-determinism bug — investigate.

- [ ] **Step 5: Write the smoke findings doc**

Create `chart-review-platform/docs/superpowers/specs/2026-05-07-codify-smoke-findings.md`:

```markdown
# Codify smoke — first run on a real locked guideline

Captured the first end-to-end codify run against a real validated cohort.

## Run

(Paste the output of `python3 -m chart_review.cli codify --task <id>` here.)

## Files written

(List the files from the JSON output above.)

## Sample artifact (kw_*)

(Paste the first 30 lines of one of the generated keyword_sets/kw_*.md files.)

## Sample artifact (codes_*)

(Paste the first 30 lines of one of the generated code_sets/codes_*.md files.)

## Sample note_type_filters

(Paste the generated note_type_filters.md.)

## Idempotency check

Re-ran the same command. Diff (excluding `codified_at` timestamps):

(Paste the diff output. Should be empty.)

## Observations

- Cohort size: <N>
- Number of criteria with keyword_sets: <N>
- Number of criteria with code_sets: <N>
- ICD prefix hints emitted: <N>
- Anything that surprised you (terms that look noisy, criteria that should have produced an artifact but didn't, etc.).

## Follow-up items

- (e.g. "the keyword set for `eye_exam_was_dilated_retinal` is dominated by 'normal' — may need a stopword extension.")
- (e.g. "no code_set for `age_at_index` — expected, since age comes from a structured field the reviewer didn't pin as evidence.")
```

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/.claude/skills/chart-review-lung-cancer-phenotype/references/ \
        chart-review-platform/docs/superpowers/specs/2026-05-07-codify-smoke-findings.md
git commit -m "smoke(codify): first end-to-end run on lung-cancer-phenotype + findings doc"
```

---

## Self-review of this plan

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| Tier 1 scope (3 artifact types) | Tasks 1–6 |
| On-demand trigger | Task 11 (UI button) + Task 8 (CLI) |
| Cohort filter (oracle_done + reviewer_validated/locked) | Task 5 (`_list_validated_reviews`) + tested in Task 5 |
| Deterministic extraction | Tasks 1, 2, 5 (no LLM, no random seed) |
| Patient-coverage ranking | Task 5 (`_build_keyword_sets` ranks by `patient_count` desc) |
| ICD prefix hints | Task 2 + Task 5 (`_build_code_sets` calls `group_icd_prefixes`) |
| Output to `references/{keyword_sets,code_sets,note_type_filters}/` | Task 6 |
| `derived_from` block on every artifact | Task 5 (`derived_from_base`) + Task 7 (test) |
| `uses:` block additive update | Task 6 (`update_uses_blocks`) + tests |
| Composition with chart-review-improve | Task 8 SKILL.md prose; no code coupling |
| Invalidation by manual_version | Task 7 |
| Failure modes: empty cohort, < 3 patients, zero-evidence criterion, OMOP lookup | Task 5 (empty cohort raises) + Task 5 tests; < 3 warning is mentioned in spec but NOT covered as a hard task — added to follow-ups below |
| Loader extension for note_type_filters | Task 10 |
| Tests (extractor, writer, uses-block, invalidation, schemas, route, button) | Tasks 1–11 |
| End-to-end smoke on real cohort | Task 12 |
| Co-required follow-up: agent runtime usage of artifacts | NOT in this plan — flagged in the spec as cluster 1.5; scope-controlled |

**Placeholder scan:** No "TBD", "TODO", or "implement later" markers. Every code block is complete.

**Type consistency:** `codify`, `write_artifacts`, `update_uses_blocks` — all referenced consistently across Tasks 5, 6, 7, 8. The bundle dict's keys (`keyword_sets`, `code_sets`, `note_type_filters`) match between extractor (Task 5) and writer (Task 6).

**Gap fixed inline:** the spec mentions a "< 3 patients warns but still produces" failure mode but no task covers it. This is small enough to fold into Task 5's failure-modes test if needed; if not, flag as follow-up. Adding here:

> **Note:** the spec's "< 3 patient cohort warns but produces" failure mode is not covered by an explicit test in this plan. Either extend `test_codify_extractor.py::test_refuses_empty_cohort` to also exercise the warning case, or accept it as a Tier-1 follow-up. The current implementation accepts cohorts of any size ≥1 without warning; the warning is a v0+ enhancement.

**Co-required cluster 1.5 (agent uses artifacts at runtime):** explicitly out of scope per the spec. Codify v0 produces correct artifacts; the chart-review skill's prompt and tool-use surface need a parallel update before subsequent agent runs see speedup. Track separately.
