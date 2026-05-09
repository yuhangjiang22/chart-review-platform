# Build the Chart Review Platform Backend Contract Kit

You are building the deterministic backbone of a configurable, human-in-the-loop EHR chart review platform. The platform is contract-first: a UI on one side and a (student-built) AI agent on the other side both talk to the same JSON contracts. Your job is the contract layer + a deterministic Python library + a synthetic-data adapter + a stub agent that lets the platform run end-to-end.

You are NOT building the AI agent. The agent's design — model choice, retrieval strategy, prompt structure, framework — is intentionally out of scope. Students will build it later, constrained only by the I/O contracts you ship.

## What you will produce

A working Python package + reference adapters + synthetic data that together let an external caller:

1. Compile any conforming task document (.md) into `CompiledTask` JSON.
2. Validate any `ReviewRecord` JSON against the canonical schemas.
3. Evaluate derivation expressions and produce derived assessments + final output.
4. Run faithfulness checks against note text.
5. Detect cross-criterion alerts.
6. Run end-to-end with a stub agent against synthetic data so students have something to swap into.

## Non-goals

- Real AI agent (out of scope; students).
- Real EHR integration (synthetic data only; OMOP-on-DuckDB is a scaffold only).
- Web server (CLI + library only).
- Authentication, multi-tenancy.

## Tech stack

- Python ≥ 3.11
- `jsonschema` for schema validation
- `python-frontmatter` + `pyyaml` for parsing markdown frontmatter and YAML blocks
- `lark` (or hand-rolled recursive-descent) for derivation expression parsing — do **NOT** use `eval()`
- `duckdb` + `pandas` for the OMOP-shaped synthetic adapter
- `rank_bm25` for note search
- `pytest` for tests
- `pyproject.toml` with `setuptools` or `hatch`

---

## Final file layout

```
chart-review-platform/
├── contracts/                       # JSON Schemas — author from spec below
│   ├── compiled_task.schema.json
│   ├── review_record.schema.json
│   ├── evidence.schema.json
│   └── trace.schema.json
├── tasks/
│   └── lung_cancer_phenotype.md     # author from spec below
├── interfaces/
│   ├── tools/                        # tool I/O specs (markdown only)
│   │   ├── omop-query.md
│   │   ├── concept-resolve.md
│   │   ├── note-search.md
│   │   └── note-read.md
│   └── skills/
│       └── skill-template.md
├── lib/                              # Python package
│   └── chart_review/
│       ├── __init__.py
│       ├── parser/
│       ├── validator/
│       ├── derivation/
│       ├── scheduler/
│       ├── faithfulness/
│       ├── alerts/
│       └── cli.py
├── adapters/
│   └── synthetic/
│       ├── omop_query.py
│       ├── concept_resolve.py
│       ├── note_search.py
│       ├── note_read.py
│       └── stub_agent.py
├── synthetic_data/
│   └── patient_001/ ... patient_020/
│       ├── person.csv
│       ├── condition_occurrence.csv
│       ├── measurement.csv
│       ├── drug_exposure.csv
│       ├── procedure_occurrence.csv
│       ├── visit_occurrence.csv
│       ├── notes/
│       │   └── <note_id>.txt
│       └── metadata.json
├── tests/
│   ├── test_parser.py
│   ├── test_validator.py
│   ├── test_derivation.py
│   ├── test_scheduler.py
│   ├── test_faithfulness.py
│   ├── test_alerts.py
│   ├── test_synthetic_adapter.py
│   └── test_e2e.py
├── pyproject.toml
└── README.md
```

---

## Canonical contracts — author exactly as specified

### `contracts/evidence.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/evidence.schema.json",
  "title": "EvidenceTriple",
  "description": "One unit of evidence supporting a criterion answer. Either a span from a clinical note or a row from an OMOP table.",
  "oneOf": [
    {
      "type": "object",
      "required": ["source", "note_id", "span_offsets", "verbatim_quote", "evidence_date"],
      "additionalProperties": false,
      "properties": {
        "source": { "const": "note" },
        "note_id": { "type": "string" },
        "doc_type": { "type": "string" },
        "span_offsets": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": { "type": "integer", "minimum": 0 }
        },
        "verbatim_quote": { "type": "string", "minLength": 1 },
        "evidence_date": { "type": "string", "format": "date" },
        "author_role": { "type": "string" }
      }
    },
    {
      "type": "object",
      "required": ["source", "table", "row_id", "evidence_date"],
      "additionalProperties": false,
      "properties": {
        "source": { "const": "omop" },
        "table": {
          "type": "string",
          "enum": ["CONDITION_OCCURRENCE", "MEASUREMENT", "DRUG_EXPOSURE", "OBSERVATION", "PROCEDURE_OCCURRENCE", "VISIT_OCCURRENCE"]
        },
        "row_id": { "type": ["string", "integer"] },
        "concept_id": { "type": "integer" },
        "concept_name": { "type": "string" },
        "value": {},
        "unit": { "type": "string" },
        "evidence_date": { "type": "string", "format": "date" }
      }
    }
  ]
}
```

### `contracts/trace.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/trace.schema.json",
  "title": "Trace shapes (per-criterion summary + per-record audit trail)",
  "$defs": {
    "TraceSummary": {
      "type": "object",
      "required": ["skills_invoked", "tools_used"],
      "additionalProperties": false,
      "properties": {
        "skills_invoked": { "type": "array", "items": { "type": "string" } },
        "tools_used": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["tool", "n_calls"],
            "additionalProperties": false,
            "properties": {
              "tool": { "type": "string" },
              "n_calls": { "type": "integer", "minimum": 0 }
            }
          }
        }
      }
    },
    "AuditEntry": {
      "type": "object",
      "required": ["timestamp", "step_type"],
      "additionalProperties": false,
      "properties": {
        "timestamp": { "type": "string", "format": "date-time" },
        "step_type": {
          "type": "string",
          "enum": ["plan", "tool_call", "tool_result", "skill_invocation", "skill_result", "answer", "self_check", "override"]
        },
        "payload": { "type": "object" },
        "model_version": { "type": "string" },
        "prompt_version": { "type": "string" },
        "skill_version": { "type": "string" },
        "tool_version": { "type": "string" }
      }
    }
  }
}
```

### `contracts/compiled_task.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/compiled_task.schema.json",
  "title": "CompiledTask",
  "type": "object",
  "required": ["task_id", "review_unit", "manual_version", "fields", "source_document_sha"],
  "additionalProperties": false,
  "properties": {
    "task_id": { "type": "string" },
    "task_type": { "type": "string" },
    "review_unit": { "type": "string", "enum": ["patient", "encounter", "episode", "event"] },
    "manual_version": { "type": "string" },
    "source_document_sha": { "type": "string" },
    "index_anchor": { "type": "string" },
    "time_windows": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "anchor", "start_offset", "end_offset"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string" },
          "anchor": { "type": "string" },
          "start_offset": { "type": "string" },
          "end_offset": { "type": "string" }
        }
      }
    },
    "final_output": { "type": "string" },
    "overview_prose": { "type": "string" },
    "fields": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/Field" }
    }
  },
  "$defs": {
    "Field": {
      "type": "object",
      "required": ["id", "answer_schema"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string" },
        "prompt": { "type": "string" },
        "answer_schema": { "type": "object" },
        "cardinality": { "type": "string", "enum": ["one", "many"], "default": "one" },
        "time_window": { "type": "string" },
        "derivation": { "type": "string" },
        "is_applicable_when": {
          "type": "string",
          "description": "Expression in the same dialect as `derivation`. When false, the field auto-resolves to `not_applicable`; the agent skips it; the UI renders it as N/A. Required for HEDIS / NCCN / quality-measure-style gating."
        },
        "is_final_output": { "type": "boolean", "default": false },
        "extraction_guidance": { "type": "string" },
        "group": { "type": "string" },
        "guidance_prose": {
          "type": "object",
          "additionalProperties": { "type": "string" }
        }
      }
    }
  }
}
```

### `contracts/review_record.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/review_record.schema.json",
  "title": "ReviewRecord",
  "type": "object",
  "required": ["record_id", "task_document_sha", "review_unit_id", "patient_id", "task_metadata_snapshot", "started_at", "criterion_assessments", "audit_trail"],
  "additionalProperties": false,
  "properties": {
    "record_id": { "type": "string" },
    "task_document_sha": { "type": "string" },
    "review_unit_id": { "type": "string" },
    "patient_id": { "type": "string" },
    "task_metadata_snapshot": { "type": "object" },
    "started_at": { "type": "string", "format": "date-time" },
    "completed_at": { "type": "string", "format": "date-time" },
    "criterion_assessments": {
      "type": "array",
      "items": { "$ref": "#/$defs/CriterionAssessment" }
    },
    "derived_assessments": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["field_id", "value", "derivation_inputs"],
        "additionalProperties": false,
        "properties": {
          "field_id": { "type": "string" },
          "value": {},
          "derivation_inputs": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["field_id", "value"],
              "additionalProperties": false,
              "properties": {
                "field_id": { "type": "string" },
                "value": {}
              }
            }
          }
        }
      }
    },
    "cross_criterion_alerts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["fields", "description", "severity"],
        "additionalProperties": false,
        "properties": {
          "fields": { "type": "array", "items": { "type": "string" } },
          "description": { "type": "string" },
          "severity": { "type": "string", "enum": ["info", "warning", "error"] }
        }
      }
    },
    "final_output": {
      "type": "object",
      "required": ["field_id", "value"],
      "additionalProperties": false,
      "properties": {
        "field_id": { "type": "string" },
        "value": {},
        "derivation_chain": { "type": "array", "items": { "type": "string" } }
      }
    },
    "audit_trail": {
      "type": "array",
      "items": { "$ref": "trace.schema.json#/$defs/AuditEntry" }
    },
    "reviewer_overrides": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["field_id", "original_value", "corrected_value", "error_category", "reviewer_id", "timestamp"],
        "additionalProperties": false,
        "properties": {
          "field_id": { "type": "string" },
          "original_value": {},
          "corrected_value": {},
          "supporting_evidence": { "type": "array", "items": { "$ref": "evidence.schema.json" } },
          "error_category": { "type": "string", "enum": ["missed_evidence", "misinterpreted", "wrong_rule", "criterion_ambiguous", "other"] },
          "free_text": { "type": "string" },
          "reviewer_id": { "type": "string" },
          "timestamp": { "type": "string", "format": "date-time" }
        }
      }
    }
  },
  "$defs": {
    "CriterionAssessment": {
      "type": "object",
      "required": ["field_id", "answer", "evidence", "coverage", "confidence"],
      "additionalProperties": false,
      "properties": {
        "field_id": { "type": "string" },
        "answer": {},
        "evidence": { "type": "array", "items": { "$ref": "evidence.schema.json" } },
        "alternatives_considered": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["value", "reason_rejected"],
            "additionalProperties": false,
            "properties": {
              "value": {},
              "reason_rejected": { "type": "string" }
            }
          }
        },
        "contradicting_evidence": {
          "description": "Evidence the agent retrieved AND read but weighed against its answer. Distinct from `coverage.excluded` (notes filtered out before reading) and `alternatives_considered` (rejected answer values). Required for honest multi-source synthesis (irAE, BARC, conflict-resolution criteria). Quoted spans must verify against source notes during faithfulness checking, exactly like primary evidence.",
          "type": "array",
          "items": {
            "type": "object",
            "required": ["evidence", "reason_not_decisive"],
            "additionalProperties": false,
            "properties": {
              "evidence": { "$ref": "evidence.schema.json" },
              "reason_not_decisive": { "type": "string" }
            }
          }
        },
        "coverage": {
          "type": "object",
          "required": ["notes_in_scope", "notes_searched", "queries_run"],
          "additionalProperties": false,
          "properties": {
            "notes_in_scope": { "type": "integer", "minimum": 0 },
            "notes_searched": { "type": "integer", "minimum": 0 },
            "notes_read_in_full": { "type": "integer", "minimum": 0 },
            "queries_run": { "type": "array", "items": { "type": "string" } },
            "structured_queries_run": { "type": "array", "items": { "type": "string" } },
            "excluded": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["note_id", "reason"],
                "additionalProperties": false,
                "properties": {
                  "note_id": { "type": "string" },
                  "reason": { "type": "string" }
                }
              }
            }
          }
        },
        "applied_rule": { "type": ["string", "null"] },
        "confidence": { "type": "string", "enum": ["low", "medium", "high"] },
        "missingness_reason": {
          "type": "string",
          "enum": ["not_documented", "not_assessed", "contradictory", "external_care", "illegible", "not_applicable"]
        },
        "faithfulness_check": {
          "type": "object",
          "required": ["status"],
          "additionalProperties": false,
          "properties": {
            "status": { "type": "string", "enum": ["pass", "partial", "fail"] },
            "details": { "type": "array", "items": { "type": "string" } }
          }
        },
        "schema_validation": {
          "type": "object",
          "required": ["status"],
          "additionalProperties": false,
          "properties": {
            "status": { "type": "string", "enum": ["pass", "fail"] },
            "errors": { "type": "array", "items": { "type": "string" } }
          }
        },
        "trace_summary": { "$ref": "trace.schema.json#/$defs/TraceSummary" },
        "reasoning_summary": { "type": "string" }
      }
    }
  }
}
```

---

## Reference task document — `tasks/lung_cancer_phenotype.md`

Author this file exactly. It is your parser's primary fixture.

````markdown
---
task_id: lung_cancer_phenotype
task_type: phenotype_validation
review_unit: patient
manual_version: "2026-04-28"
index_anchor: index_date
time_windows:
  - { id: lookback_24mo, anchor: index_anchor, start_offset: -24mo, end_offset: 0d }
final_output: lung_cancer_status
---

# Lung Cancer Phenotype Review

## Overview

This task determines whether a patient has lung cancer based on their EHR record. The phenotype produces a three-tier label: `confirmed` (pathology-supported), `probable` (imaging plus clinical diagnosis, or coding-only), or `absent` (no supporting evidence in the lookback window).

**Source-document priority** (apply globally unless a field overrides):

1. Surgical pathology report (LOINC 11526-1)
2. Biopsy pathology report
3. Outside-institution pathology in the media tab
4. Treating-oncologist progress notes
5. Imaging reports (CT chest, PET-CT)
6. Problem list / encounter ICD codes

**Lookback window** is 24 months prior to the index date. The index date is the start of the encounter that triggered the review.

## Field `pathology_report_present`

```yaml
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: pathology
extraction_guidance: "Search note documents tagged pathology_report, surgical_pathology, or LOINC 11526-1."
```

### Definition
A pathology report authored by a credentialed pathologist. Surgical and biopsy specimens both qualify. Cytology-only diagnoses do not qualify here — record `no` and let `pathology_lung_primary` capture cytology separately if needed.

### Source-document priority
1. Surgical pathology report (LOINC 11526-1)
2. Biopsy pathology report
3. Scanned outside-institution pathology in the media tab

### Examples
- "Final diagnosis: Adenocarcinoma of the lung, T2N1M0" → `yes`
- "Suspicious for malignancy, recommend re-biopsy" → `no_info`
- No pathology document found in the 24-month window → `no`

## Field `pathology_lung_primary`

```yaml
answer_schema: { enum: [nsclc, sclc, other_lung, non_lung, no_info] }
cardinality: one
time_window: lookback_24mo
group: pathology
extraction_guidance: "Only evaluate when pathology_report_present == 'yes'. Apply WHO mapping below."
```

### Definition / WHO mapping
NSCLC subtypes (adenocarcinoma, squamous cell carcinoma, large-cell carcinoma) collapse to `nsclc`. Carcinoid tumors map to `other_lung`. Mesothelioma maps to `non_lung`. Metastatic disease without lung primary → `non_lung`.

### Conflict resolution
If multiple pathology reports conflict, prefer the most recent unless a documented re-read exists. If a re-read is documented, the re-read wins regardless of date.

### Examples
- "Adenocarcinoma of the lung" → `nsclc`
- "Small cell carcinoma, lung" → `sclc`
- "Carcinoid tumor of the lung" → `other_lung`
- "Metastatic colorectal carcinoma" → `non_lung`

## Field `imaging_lung_lesion`

```yaml
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: imaging
```

### Definition
Imaging (CT chest, PET-CT, chest X-ray) shows a lung mass, nodule, or lesion suspicious for malignancy. Stable benign-appearing nodules do not qualify.

### Examples
- "3.2 cm spiculated mass in the right upper lobe, highly suspicious for malignancy" → `yes`
- "Stable 4 mm nodule, likely granuloma" → `no`
- "No prior imaging available for comparison" → `no_info`

## Field `oncologist_lung_cancer_diagnosis_in_note`

```yaml
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: clinical_diagnosis
extraction_guidance: "Author role must be oncologist or pulmonologist. Family history mentions do not count."
```

### Definition
A treating oncologist or pulmonologist documents lung cancer as the patient's diagnosis (active or historical). Family history mentions, "rule out" language, and provider-questioned diagnoses do **not** qualify.

### Examples
- Oncology progress note: "Patient with stage IIIA NSCLC, currently on cisplatin/etoposide" → `yes`
- "Father with history of lung cancer" → `no`
- "Considering lung cancer in differential, awaiting biopsy" → `no_info`

## Field `icd_lung_cancer_present`

```yaml
answer_schema: { enum: [yes, no] }
cardinality: one
time_window: lookback_24mo
group: codes
extraction_guidance: "Query CONDITION_OCCURRENCE for ICD-10-CM C34.* codes. Personal-history codes (Z85.118) do not qualify here."
```

### Definition
An ICD-10-CM code in the C34.* family appears on the patient's problem list or any encounter diagnosis within the lookback window.

### Examples
- C34.10 on a 2025-09-12 encounter → `yes`
- Only Z85.118 ("personal history of malignant neoplasm of bronchus and lung") → `no`
- No relevant codes → `no`

## Field `pathology_confirms_lung_cancer`

```yaml
derivation: "pathology_report_present == 'yes' AND pathology_lung_primary in ['nsclc','sclc','other_lung']"
answer_schema: { type: boolean }
group: derived
```

### Definition
True iff a pathology report exists AND it identifies a lung primary malignancy. Derived field — no evidence required; provenance is the input field values.

## Field `clinical_diagnosis_lung_cancer`

```yaml
derivation: "imaging_lung_lesion == 'yes' AND oncologist_lung_cancer_diagnosis_in_note == 'yes'"
answer_schema: { type: boolean }
group: derived
```

### Definition
True iff imaging shows a suspicious lung lesion AND a treating oncologist or pulmonologist documents lung cancer.

## Field `lung_cancer_status`

```yaml
derivation: |
  pathology_confirms_lung_cancer == true ? 'confirmed' :
  (clinical_diagnosis_lung_cancer == true OR icd_lung_cancer_present == 'yes') ? 'probable' :
  'absent'
answer_schema: { enum: [confirmed, probable, absent] }
is_final_output: true
group: final
```

### Tier rationale
- `confirmed` requires pathology evidence — the highest-tier evidence available in routine EHR.
- `probable` allows two paths: clinical-diagnosis-with-imaging-support, or an ICD code (the weakest signal but included to match how chart reviewers operate when full pathology is missing).
- `absent` is asserted only when all leaf fields have been evaluated and none support lung cancer.
````

---

## Tool I/O specs — author markdown files at `interfaces/tools/`

These are **specifications only** — students implement them. The synthetic adapter you ship implements them as a reference.

### `interfaces/tools/omop-query.md`

```markdown
# Tool: omop-query

Query a patient's OMOP records for rows matching a concept set within a time window.

## Signature

omop-query(patient_id: string, concept_set: string[] | { concept_ids: int[] }, time_window: { start: ISO8601, end: ISO8601 } | null) → row[]

## Behavior

- Searches CONDITION_OCCURRENCE, MEASUREMENT, DRUG_EXPOSURE, OBSERVATION, PROCEDURE_OCCURRENCE, VISIT_OCCURRENCE.
- concept_set may be explicit concept_ids or a logical name resolved via concept-resolve.
- time_window filters the relevant date column. If null, no time filter.

## Return shape

Each row matches the source OMOP table's columns plus:
- _table: the OMOP table name
- _row_id: stable identifier (used in evidence triples)
- _concept_id, _concept_name: the matched concept
- _evidence_date: relevant date column for that table

## Errors

- patient_not_found → return [] and signal via structured error field
- time_window_invalid → return [] and signal
```

### `interfaces/tools/concept-resolve.md`

```markdown
# Tool: concept-resolve

Resolve a concept name or natural-language definition into a code set.

## Signature

concept-resolve(query: string, vocabularies?: string[]) → { concept_ids: int[], concept_names: string[], vocabulary: string }

## Behavior

- Accepts a concept name ("lung cancer"), code prefix ("C34"), or natural-language definition.
- vocabularies optionally restricts to ICD-10-CM, SNOMED, RxNorm, LOINC, etc.
- Implementation may use Athena, a local concept table, or LLM-mediated expansion.

## Errors

- no_match → concept_ids: [] with signal
- ambiguous → return most likely match with flag
```

### `interfaces/tools/note-search.md`

```markdown
# Tool: note-search

Search a patient's clinical notes by keyword or concept, returning ranked results.

## Signature

note-search(patient_id: string, query: string | { keywords: string[], concept_set?: int[] }, time_window?: { start: ISO8601, end: ISO8601 }, doc_types?: string[]) → ranked_results[]

## Behavior

- Searches the patient's full clinical note corpus.
- query may be free text, keywords, or a concept set.
- time_window filters by note authoring date.
- doc_types restricts to specific document types.
- Ranking is implementation-specific (BM25, dense retrieval, hybrid).

## Return shape

Each result:
- note_id
- doc_type
- snippet (with character offsets)
- date
- score

## Errors

- patient_not_found → []
- query_invalid → []
```

### `interfaces/tools/note-read.md`

```markdown
# Tool: note-read

Retrieve a clinical note's full text plus character offset map.

## Signature

note-read(note_id: string) → { full_text: string, offset_map: OffsetMap, metadata: NoteMetadata }

## Behavior

- Returns the note's complete text.
- Returns offset_map for translating semantic structure to character offsets (sections, paragraphs).
- Returns metadata: doc_type, date, author_id, author_role, encounter_id, patient_id.

## Errors

- note_not_found → raise (hard error; callers cite note_id directly)
```

### `interfaces/skills/skill-template.md`

```markdown
# Skill I/O Template

A skill is a reusable extraction procedure invoked by an agent to answer one chart review field. The contract fixes the I/O envelope; the skill's internals are implementation work.

## Required input envelope

{
  field_id: string,
  answer_schema: <JSON Schema fragment from the field>,
  time_window: { id, start, end } | null,
  patient_id: string,
  extraction_guidance: string | null,
  manual_section: string | null
}

## Required output envelope

{
  answer: <validates against answer_schema>,
  evidence: [<evidence triple>, ...],
  alternatives_considered: [{ value, reason_rejected }],
  coverage: { notes_in_scope, notes_searched, notes_read_in_full, queries_run, structured_queries_run, excluded },
  applied_rule: string | null,
  confidence: "low" | "medium" | "high",
  missingness_reason: <enum, when applicable>,
  reasoning_summary: string | null   # audit-only; UI never displays on primary surface
}

## Quality bar

A skill output passes review iff:
1. answer validates against answer_schema.
2. Every quote in evidence[].verbatim_quote exists at the cited span_offsets in the corresponding note.
3. coverage.notes_searched is non-zero unless the field is structured-only.
4. confidence == low whenever evidence is empty or single-source.
```

---

## Task document format — what the parser must accept

A task document is a single markdown file combining the abstraction manual (prose) with the executable checklist schema (structured blocks).

### Frontmatter (required)

```yaml
---
task_id: <stable_id>
task_type: <free string>
review_unit: patient | encounter | episode | event
manual_version: <ISO date or semver>
index_anchor: <field id or task-level expression>
time_windows:
  - { id: <name>, anchor: <id>, start_offset: <duration>, end_offset: <duration> }
final_output: <field id with is_final_output: true>
---
```

### Body

- `# <Title>` H1 heading
- `## Overview` section (prose → `overview_prose`)
- One or more `## Field <id>` sections; the id is in backticks: `` ## Field `pathology_report_present` ``

### Each field section

- First fenced YAML code block defines the field's structure (parses to the Field object).
- Subsequent `### <Section name>` headings inside the field become `guidance_prose[<normalized_key>]`.
- Normalization: lowercase, replace spaces and hyphens with underscores. So `### Source-document priority` → `guidance_prose.source_document_priority`.

---

## Library modules and behaviors

Each module ships with unit tests; tests must pass before moving to the next module.

### `lib/chart_review/parser/`

Parses a task document (.md) into a `CompiledTask` dict.

- Reads frontmatter using `python-frontmatter`.
- Splits the body by `## Field <id>` headers (id captured from backticks).
- For each field, extracts the first ```` ```yaml ```` block as the structure block.
- For each subsequent `### <Section>` heading inside the field, captures the prose and stores it under `guidance_prose[<normalized_key>]`.
- Captures the `## Overview` body as `overview_prose`.
- Computes `source_document_sha` as SHA-256 of the raw markdown bytes.
- Returns a dict that validates against `contracts/compiled_task.schema.json`.

**Tests:**
- Compile `tasks/lung_cancer_phenotype.md` end-to-end and validate against the schema.
- Reject frontmatter missing required fields with a clear error.
- Reject a field block missing `answer_schema` with a clear error.
- Round-trip preserve all 8 field ids in the exemplar.
- Verify `guidance_prose.source_document_priority` is populated for `pathology_report_present`.

### `lib/chart_review/validator/`

Validates an answer matches a field's `answer_schema`.

- Uses `jsonschema` to validate `answer` against `answer_schema`.
- Returns `{ status: "pass" | "fail", errors: [...] }`.
- For derived fields, validation runs after derivation evaluation (against the derived value).

**Tests:**
- Pass: `{ enum: [met, not_met] }` with answer `"met"`.
- Fail: `{ enum: [met, not_met] }` with answer `"yes"`.
- Pass: `{ type: number, unit: "%" }` with answer `9.2`.
- Pass: `{ type: boolean }` with answer `true`.

### `lib/chart_review/derivation/`

Evaluates a derivation expression over filled field values.

- Supports: comparison (`==`, `!=`, `>`, `>=`, `<`, `<=`), Boolean (`AND`, `OR`, `NOT`), set membership (`in`), ternary (`<cond> ? <then> : <else>`), and string/number/boolean literals.
- Resolves bare field ids by looking them up in `values: dict[field_id, value]`.
- Multi-line expressions (chained ternaries) flatten into a single expression.
- Use `lark`, `pyparsing`, or hand-written recursive descent. **Do NOT use `eval()`.**

**Tests:**
- `"a == 'yes' AND b > 5"` with `{a: "yes", b: 7}` → `true`.
- The full `lung_cancer_status` derivation evaluates correctly across these input combinations:
  - pathology confirmed → `'confirmed'`
  - clinical diagnosis only → `'probable'`
  - ICD only → `'probable'`
  - nothing supporting → `'absent'`
- Unknown field id raises a clear error.
- Reject expressions containing function calls or arbitrary Python.

### `lib/chart_review/scheduler/`

Builds a dependency DAG of fields and yields evaluation order.

- Leaf fields (no `derivation`) first, in any order (independent).
- Derived fields wait until all field ids referenced in their derivation expression have values.
- Detect cycles and raise `CycleError`.

**Tests:**
- Exemplar yields a valid topological order with leaves first.
- A self-referential derivation raises `CycleError`.

### `lib/chart_review/faithfulness/`

Verifies every evidence quote exists at its claimed offsets in the source note.

- Input: `CriterionAssessment.evidence` list + a function `get_note_text(note_id) → str`.
- For each `source: note` evidence, fetch note text and check `text[start:end] == verbatim_quote`. Tolerate whitespace normalization (collapse runs of whitespace to single spaces) but report any mismatch in `details`.
- For each `source: omop` evidence, no verification.
- Return `{ status: "pass" | "partial" | "fail", details: [...] }`. `partial` if some pass and some fail; `fail` if all fail.

**Tests:**
- Mock returns `"abc Adenocarcinoma of the lung xyz"`; evidence quote `"Adenocarcinoma of the lung"` at offsets `[4, 30]` → `pass`.
- Wrong offsets → `fail`.
- Mixed pass/fail → `partial`.
- Whitespace-normalized match (e.g., quote has single space, text has double) → `pass`.

### `lib/chart_review/alerts/`

Detects cross-criterion contradictions on a ReviewRecord.

- Loads a `CompiledTask` and a `ReviewRecord`.
- Runs registered detectors. Initial set:
  - `derivation_input_missing`: warns when a derived field's input is `no_info` or missing.
  - `inconsistent_diagnosis_vs_lab`: warns when a diagnosis field is `not_met` but a related lab/value field is in the disease range. (For MVP, configured per task in a top-level `alerts:` frontmatter block. If no such block exists, this detector is a no-op.)
- Each detector emits `{ fields: [...], description, severity }`.

**Tests:**
- `derivation_input_missing` triggers exactly once for a record where `pathology_lung_primary` is `no_info` but `pathology_confirms_lung_cancer` was derived.
- Empty/clean record produces no alerts.

### `lib/chart_review/cli.py`

CLI entrypoint:

- `python -m chart_review compile <task.md>` → emits CompiledTask JSON to stdout.
- `python -m chart_review validate <review_record.json>` → exits 0 if valid, 1 if not.
- `python -m chart_review run <task.md> <patient_id> --agent stub` → end-to-end pipeline using the stub agent.

---

## Synthetic data adapter

### Patient corpus — `synthetic_data/patient_001/` … `synthetic_data/patient_020/`

Generate 20 patients covering these scenarios in roughly equal proportions:

- 5 patients with confirmed NSCLC (pathology + imaging + ICD + onc note)
- 3 patients with confirmed SCLC
- 4 patients with probable lung cancer (imaging + onc note, no pathology)
- 3 patients with ICD-only (C34.* code, no other supporting evidence)
- 5 patients with no lung cancer (some with benign nodules, some with no related findings)

Per patient, generate:

- OMOP-shaped CSVs: `person.csv`, `condition_occurrence.csv`, `measurement.csv`, `drug_exposure.csv`, `procedure_occurrence.csv`, `visit_occurrence.csv`.
- 3–10 fictional clinical notes as `notes/<note_id>.txt`. Doc types include `progress_note`, `pathology_report`, `radiology_report`, `discharge_summary`.
- `metadata.json`: `{ patient_id, ground_truth: { lung_cancer_status, expected_field_answers: { ... } } }`.

Use a fixed random seed (e.g., 42) for reproducibility.

### Adapter implementations — `adapters/synthetic/`

Implements the four tool interfaces against the synthetic corpus:

- `omop_query.py` — DuckDB or pandas over the patient's CSV bundle.
- `concept_resolve.py` — reads from a small bundled `concepts.csv` (~50 concepts: lung cancer ICD codes, common labs, common imaging procedures).
- `note_search.py` — BM25 search via `rank_bm25`.
- `note_read.py` — reads `notes/<note_id>.txt`, returns text + a simple offset_map (sections detected by `\n## ` or `\n\n`).

Each adapter must satisfy the I/O contracts in `interfaces/tools/`.

### Stub agent — `adapters/synthetic/stub_agent.py`

A deliberately dumb agent for testing the platform's plumbing — **NOT** a reference for student agents.

- Reads `metadata.json.expected_field_answers` and returns those answers verbatim for each leaf field.
- Generates plausible evidence triples by picking a real note span containing a relevant keyword from the patient's notes (use `note_search` + `note_read` to find one).
- Always reports `confidence: "medium"`.
- Banner comment at the top:

  ```python
  # DO NOT use this as an agent reference. It cheats by reading ground truth
  # from metadata.json. Its sole purpose is testing the platform plumbing.
  ```

---

## Acceptance criteria

The work is complete when ALL of the following hold. Verify each by running the listed command and checking output.

1. **All four schemas valid JSON.**
   `python3 -c "import json; [json.load(open(f)) for f in ['chart-review-platform/contracts/' + s for s in ['evidence.schema.json','trace.schema.json','compiled_task.schema.json','review_record.schema.json']]]; print('OK')"` → `OK`

2. **Exemplar compiles.**
   `python -m chart_review compile chart-review-platform/tasks/lung_cancer_phenotype.md` emits valid JSON that validates against `compiled_task.schema.json`. All 8 fields present.

3. **All unit tests pass.**
   `pytest chart-review-platform/tests/ -v` is green.

4. **End-to-end pipeline runs for every synthetic patient.**
   For each `patient_001` through `patient_020`: `python -m chart_review run chart-review-platform/tasks/lung_cancer_phenotype.md patient_NNN --agent stub` emits a valid ReviewRecord.

5. **Stub agent recovers ground truth.**
   For all 20 synthetic patients, the e2e pipeline produces a `final_output.value` matching `metadata.json.ground_truth.lung_cancer_status`.

6. **Faithfulness check works on corruption.**
   Manually corrupt one evidence offset in a stub-agent ReviewRecord; the faithfulness check reports `partial` or `fail` for that criterion.

7. **README documents** how a downstream user (a student) implements their own agent against the contracts. Include: where the schemas live, the skill envelope shape, how to run e2e against the synthetic corpus, and how to swap the stub agent for their own (drop a Python module that implements the I/O envelope; update the CLI's `--agent` argument).

## Process expectations

- **Test-driven.** Write the failing test, then the implementation. Commit after each green test.
- **Small commits.** One module's tests + implementation per commit.
- **No premature optimization.** Pandas + DuckDB at this scale is fine.
- **No mocking the contract schemas.** Run real validation against the real JSON Schema files.
- **No `eval()`** in the derivation evaluator. Use a real parser.
- **Document any contract issues you find** before changing anything in `contracts/`. Surface, don't silently fix.
