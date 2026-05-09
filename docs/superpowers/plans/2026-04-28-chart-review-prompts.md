# Agentic Chart Review — Prompt Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce two self-contained prompts (backend contract kit, frontend reviewer UI) plus the shared canonical artifacts (JSON Schemas + reference task document) they depend on. Both prompts are designed to be handed to a downstream coding agent / `claude design` to scaffold the chart review platform.

**Architecture:** Three phases. Phase 1 authors the canonical contracts and reference exemplar that both prompts depend on. Phase 2 writes the backend prompt (telling a coding agent to scaffold the deterministic library, synthetic data adapter, and student-facing tool/skill stubs). Phase 3 writes the frontend prompt (telling `claude design` to build a validation-first reviewer UI consuming the contracts). All three phases produce text artifacts; no executable code is written by this plan.

**Tech Stack:** Markdown (prompts, task documents, interface specs); JSON Schema (Draft 2020-12) for contracts. Downstream prompts target Python/TypeScript for the backend library and React/HTML/CSS for the UI, but the plan itself is language-agnostic.

**Reference:** `docs/superpowers/specs/2026-04-28-agentic-chart-review-design.md`

---

## Phase 0 — Repo scaffold

### Task 0: Create project subdirectories

**Files:**
- Create: `chart-review-platform/contracts/.gitkeep`
- Create: `chart-review-platform/tasks/.gitkeep`
- Create: `chart-review-platform/interfaces/tools/.gitkeep`
- Create: `chart-review-platform/interfaces/skills/.gitkeep`
- Create: `chart-review-platform/prompts/.gitkeep`

- [ ] **Step 1: Create directories**

```bash
cd "Studies/Chart Review Agents"
mkdir -p chart-review-platform/{contracts,tasks,interfaces/tools,interfaces/skills,prompts}
touch chart-review-platform/contracts/.gitkeep \
      chart-review-platform/tasks/.gitkeep \
      chart-review-platform/interfaces/tools/.gitkeep \
      chart-review-platform/interfaces/skills/.gitkeep \
      chart-review-platform/prompts/.gitkeep
```

- [ ] **Step 2: Verify structure**

Run: `find chart-review-platform -type d`
Expected:
```
chart-review-platform
chart-review-platform/contracts
chart-review-platform/tasks
chart-review-platform/interfaces
chart-review-platform/interfaces/tools
chart-review-platform/interfaces/skills
chart-review-platform/prompts
```

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform
git commit -m "chore: scaffold chart-review-platform directory structure"
```

---

## Phase 1 — Canonical artifacts

These files are referenced by both prompts. They are the single source of truth for the contract.

### Task 1: Author `evidence.schema.json`

**Files:**
- Create: `chart-review-platform/contracts/evidence.schema.json`

- [ ] **Step 1: Write the schema**

Create `chart-review-platform/contracts/evidence.schema.json` with the exact content below.

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
        "doc_type": { "type": "string", "description": "e.g. 'progress_note', 'pathology_report', 'discharge_summary'" },
        "span_offsets": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": { "type": "integer", "minimum": 0 },
          "description": "[start_offset, end_offset_exclusive] in characters within the note's full text"
        },
        "verbatim_quote": { "type": "string", "minLength": 1 },
        "evidence_date": { "type": "string", "format": "date" },
        "author_role": { "type": "string", "description": "e.g. 'attending', 'resident', 'nurse', 'pathologist'" }
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
          "enum": [
            "CONDITION_OCCURRENCE",
            "MEASUREMENT",
            "DRUG_EXPOSURE",
            "OBSERVATION",
            "PROCEDURE_OCCURRENCE",
            "VISIT_OCCURRENCE"
          ]
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

- [ ] **Step 2: Validate the schema is well-formed**

Run: `python3 -c "import json; json.load(open('chart-review-platform/contracts/evidence.schema.json')); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform/contracts/evidence.schema.json
git commit -m "feat: add evidence.schema.json for two-source evidence triples"
```

---

### Task 2: Author `trace.schema.json`

**Files:**
- Create: `chart-review-platform/contracts/trace.schema.json`

- [ ] **Step 1: Write the schema**

Create `chart-review-platform/contracts/trace.schema.json` with the exact content below.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/trace.schema.json",
  "title": "Trace shapes (per-criterion summary + per-record audit trail)",
  "$defs": {
    "TraceSummary": {
      "type": "object",
      "description": "Compact per-criterion trace surfaced in the secondary UI layer.",
      "required": ["skills_invoked", "tools_used"],
      "additionalProperties": false,
      "properties": {
        "skills_invoked": {
          "type": "array",
          "items": { "type": "string" }
        },
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
      "description": "One step in the forensic audit trail (Layer 3).",
      "required": ["timestamp", "step_type"],
      "additionalProperties": false,
      "properties": {
        "timestamp": { "type": "string", "format": "date-time" },
        "step_type": {
          "type": "string",
          "enum": ["plan", "tool_call", "tool_result", "skill_invocation", "skill_result", "answer", "self_check", "override"]
        },
        "payload": { "type": "object", "description": "Step-specific data; structure is step_type-dependent." },
        "model_version": { "type": "string" },
        "prompt_version": { "type": "string" },
        "skill_version": { "type": "string" },
        "tool_version": { "type": "string" }
      }
    }
  }
}
```

- [ ] **Step 2: Validate the schema is well-formed**

Run: `python3 -c "import json; json.load(open('chart-review-platform/contracts/trace.schema.json')); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform/contracts/trace.schema.json
git commit -m "feat: add trace.schema.json for trace summary and audit entries"
```

---

### Task 3: Author `compiled_task.schema.json`

**Files:**
- Create: `chart-review-platform/contracts/compiled_task.schema.json`

- [ ] **Step 1: Write the schema**

Create `chart-review-platform/contracts/compiled_task.schema.json` with the exact content below.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/compiled_task.schema.json",
  "title": "CompiledTask",
  "description": "Machine-readable view of a task document after parsing the markdown source.",
  "type": "object",
  "required": ["task_id", "review_unit", "manual_version", "fields", "source_document_sha"],
  "additionalProperties": false,
  "properties": {
    "task_id": { "type": "string" },
    "task_type": { "type": "string" },
    "review_unit": { "type": "string", "enum": ["patient", "encounter", "episode", "event"] },
    "manual_version": { "type": "string" },
    "source_document_sha": { "type": "string", "description": "Content hash of the markdown source document." },
    "index_anchor": { "type": "string", "description": "Field id, or task-level expression, defining time-zero." },
    "time_windows": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "anchor", "start_offset", "end_offset"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string" },
          "anchor": { "type": "string" },
          "start_offset": { "type": "string", "description": "ISO-8601-style duration, signed (e.g. '-24mo', '0d')" },
          "end_offset": { "type": "string" }
        }
      }
    },
    "final_output": { "type": "string", "description": "Field id of the field with is_final_output: true." },
    "overview_prose": { "type": "string", "description": "Free-form prose from the document's Overview section." },
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
        "prompt": { "type": "string", "description": "One-line description of what the field asks." },
        "answer_schema": {
          "type": "object",
          "description": "JSON Schema fragment describing the answer's shape (enum / number / string / date / boolean / object)."
        },
        "cardinality": { "type": "string", "enum": ["one", "many"], "default": "one" },
        "time_window": { "type": "string" },
        "derivation": { "type": "string", "description": "Expression over other field ids; if set, this field is computed, not extracted." },
        "is_final_output": { "type": "boolean", "default": false },
        "extraction_guidance": { "type": "string" },
        "group": { "type": "string" },
        "guidance_prose": {
          "type": "object",
          "description": "Bundled prose sections from the markdown for this field, addressable by section name.",
          "additionalProperties": { "type": "string" },
          "properties": {
            "definition": { "type": "string" },
            "source_document_priority": { "type": "string" },
            "examples": { "type": "string" }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Validate the schema is well-formed**

Run: `python3 -c "import json; json.load(open('chart-review-platform/contracts/compiled_task.schema.json')); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform/contracts/compiled_task.schema.json
git commit -m "feat: add compiled_task.schema.json for parsed task document structure"
```

---

### Task 4: Author `review_record.schema.json`

**Files:**
- Create: `chart-review-platform/contracts/review_record.schema.json`

- [ ] **Step 1: Write the schema**

Create `chart-review-platform/contracts/review_record.schema.json` with the exact content below. The schema references `evidence.schema.json` and `trace.schema.json` by relative `$ref`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/contracts/review_record.schema.json",
  "title": "ReviewRecord",
  "description": "The structured output produced by an agent for one chart review case.",
  "type": "object",
  "required": [
    "record_id",
    "task_document_sha",
    "review_unit_id",
    "patient_id",
    "task_metadata_snapshot",
    "started_at",
    "criterion_assessments",
    "audit_trail"
  ],
  "additionalProperties": false,
  "properties": {
    "record_id": { "type": "string" },
    "task_document_sha": { "type": "string" },
    "review_unit_id": { "type": "string" },
    "patient_id": { "type": "string" },
    "task_metadata_snapshot": {
      "type": "object",
      "description": "Frozen copy of the compiled_task frontmatter at review time."
    },
    "started_at": { "type": "string", "format": "date-time" },
    "completed_at": { "type": "string", "format": "date-time" },

    "criterion_assessments": {
      "type": "array",
      "items": { "$ref": "#/$defs/CriterionAssessment" }
    },

    "derived_assessments": {
      "type": "array",
      "description": "Populated by the deterministic derivation evaluator, not by the agent.",
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
      "description": "Populated by the deterministic alerts utility.",
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
        "derivation_chain": {
          "type": "array",
          "items": { "type": "string", "description": "Ordered field_ids whose derivations fed the final output." }
        }
      }
    },

    "audit_trail": {
      "type": "array",
      "items": { "$ref": "trace.schema.json#/$defs/AuditEntry" }
    },

    "reviewer_overrides": {
      "type": "array",
      "description": "Populated by the UI when a human reviewer overrides an agent answer.",
      "items": {
        "type": "object",
        "required": ["field_id", "original_value", "corrected_value", "error_category", "reviewer_id", "timestamp"],
        "additionalProperties": false,
        "properties": {
          "field_id": { "type": "string" },
          "original_value": {},
          "corrected_value": {},
          "supporting_evidence": {
            "type": "array",
            "items": { "$ref": "evidence.schema.json" }
          },
          "error_category": {
            "type": "string",
            "enum": ["missed_evidence", "misinterpreted", "wrong_rule", "criterion_ambiguous", "other"]
          },
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
        "answer": { "description": "Must validate against the field's answer_schema (validated externally)." },
        "evidence": {
          "type": "array",
          "items": { "$ref": "evidence.schema.json" }
        },
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
        "applied_rule": { "type": ["string", "null"], "description": "Identifier of the rule from the manual that was applied (e.g. 'most_recent_pathology_wins'); null if no rule fired." },
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
        "reasoning_summary": { "type": "string", "description": "Optional, audit-only. UI must NOT display on primary surface." }
      }
    }
  }
}
```

- [ ] **Step 2: Validate the schema is well-formed**

Run: `python3 -c "import json; json.load(open('chart-review-platform/contracts/review_record.schema.json')); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform/contracts/review_record.schema.json
git commit -m "feat: add review_record.schema.json — agent's output contract"
```

---

### Task 5: Author the lung cancer reference exemplar

**Files:**
- Create: `chart-review-platform/tasks/lung_cancer_phenotype.md`

The exemplar serves three roles: (a) as the canonical example referenced by both prompts, (b) as a parser test fixture, (c) as a teaching artifact for task authors.

- [ ] **Step 1: Write the exemplar — frontmatter and overview**

Create `chart-review-platform/tasks/lung_cancer_phenotype.md` starting with this header. Use exact whitespace.

```markdown
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

**Disposition logic** (encoded in the `lung_cancer_status` derivation):

- `confirmed` requires a pathology report identifying a lung primary malignancy.
- `probable` if (imaging shows a lung lesion AND oncologist documents lung cancer in a progress note) OR an ICD C34.* code is present.
- `absent` only when the lookback window is fully reviewed and no supporting evidence is found. Default is **not** absent on missing data — use `no_info` at the field level instead.
```

- [ ] **Step 2: Add leaf fields (predicate + value extractions)**

Append the following sections to the file. Each `## Field <id>` block has a fenced YAML structure block followed by prose.

````markdown

## Field `pathology_report_present`

```yaml
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: pathology
extraction_guidance: "Search note documents tagged pathology_report, surgical_pathology, or LOINC 11526-1. See definition for cytology handling."
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

---

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

---

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

---

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

---

## Field `icd_lung_cancer_present`

```yaml
answer_schema: { enum: [yes, no] }
cardinality: one
time_window: lookback_24mo
group: codes
extraction_guidance: "Query CONDITION_OCCURRENCE for ICD-10-CM C34.* codes (malignant neoplasm of bronchus and lung). Personal-history codes (Z85.118) do not qualify here."
```

### Definition

An ICD-10-CM code in the C34.* family appears on the patient's problem list or any encounter diagnosis within the lookback window.

### Examples

- C34.10 on a 2025-09-12 encounter → `yes`
- Only Z85.118 ("personal history of malignant neoplasm of bronchus and lung") → `no`
- No relevant codes → `no`
````

- [ ] **Step 3: Add derived fields and final output**

Append the derivation fields to the same file.

````markdown

---

## Field `pathology_confirms_lung_cancer`

```yaml
derivation: "pathology_report_present == 'yes' AND pathology_lung_primary in ['nsclc','sclc','other_lung']"
answer_schema: { type: boolean }
group: derived
```

### Definition

True iff a pathology report exists AND it identifies a lung primary malignancy (any WHO subtype). Derived field — no evidence required; provenance is the input field values.

---

## Field `clinical_diagnosis_lung_cancer`

```yaml
derivation: "imaging_lung_lesion == 'yes' AND oncologist_lung_cancer_diagnosis_in_note == 'yes'"
answer_schema: { type: boolean }
group: derived
```

### Definition

True iff imaging shows a suspicious lung lesion AND a treating oncologist or pulmonologist documents lung cancer. Used as one path to the `probable` tier.

---

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
- `probable` allows two paths: clinical-diagnosis-with-imaging-support, or an ICD code (note: ICD-only is the weakest signal but is included to match how chart reviewers typically operate when full pathology is missing).
- `absent` is asserted only when all leaf fields have been evaluated and none support lung cancer. Reviewer must confirm no `no_info` answers remain at any leaf field before signing off on `absent`.
````

- [ ] **Step 4: Verify the document is well-formed**

Run: `wc -l chart-review-platform/tasks/lung_cancer_phenotype.md`
Expected: at least 150 lines.

Run: `grep -c "^## Field " chart-review-platform/tasks/lung_cancer_phenotype.md`
Expected: `8` (5 leaf fields + 2 derived + 1 final)

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/tasks/lung_cancer_phenotype.md
git commit -m "feat: add lung cancer phenotype reference exemplar"
```

---

### Task 6: Author tool I/O specs

**Files:**
- Create: `chart-review-platform/interfaces/tools/omop-query.md`
- Create: `chart-review-platform/interfaces/tools/concept-resolve.md`
- Create: `chart-review-platform/interfaces/tools/note-search.md`
- Create: `chart-review-platform/interfaces/tools/note-read.md`

Each tool spec is a small markdown file documenting its signature and behavior. Implementations are student work; these specs are the contract.

- [ ] **Step 1: Write `omop-query.md`**

```markdown
# Tool: `omop-query`

Query a patient's OMOP records for rows matching a concept set within a time window.

## Signature

```
omop-query(patient_id: string, concept_set: string[] | { concept_ids: int[] }, time_window: { start: ISO8601, end: ISO8601 } | null) → row[]
```

## Behavior

- Searches the standard OMOP CDM tables: CONDITION_OCCURRENCE, MEASUREMENT, DRUG_EXPOSURE, OBSERVATION, PROCEDURE_OCCURRENCE, VISIT_OCCURRENCE.
- `concept_set` may be an explicit list of concept_ids or a logical name resolved via `concept-resolve`.
- `time_window` filters the relevant date column for each table (e.g., `condition_start_date` for CONDITION_OCCURRENCE). If `null`, no time filter is applied.

## Return shape

Each row matches the source OMOP table's columns, plus:
- `_table`: the OMOP table name
- `_row_id`: a stable identifier for the row (used in evidence triples)
- `_concept_id`, `_concept_name`: the matched concept
- `_evidence_date`: the relevant date column for that table

## Error modes

- `patient_not_found` — return `[]` and signal via a structured error field, do not raise.
- `time_window_invalid` — return `[]` and signal.
```

- [ ] **Step 2: Write `concept-resolve.md`**

```markdown
# Tool: `concept-resolve`

Resolve a concept name or natural-language definition into a code set.

## Signature

```
concept-resolve(query: string, vocabularies?: string[]) → { concept_ids: int[], concept_names: string[], vocabulary: string }
```

## Behavior

- Accepts a concept name (e.g., "lung cancer"), a code prefix (e.g., "C34"), or a natural-language definition.
- `vocabularies` optionally restricts to ICD-10-CM, SNOMED, RxNorm, LOINC, etc. Default: all standard vocabularies.
- Returns the expanded code set with concept names. Implementation may use Athena, a local concept table, or LLM-mediated expansion — the contract does not specify.

## Return shape

- `concept_ids`: integer concept_ids in the OMOP vocabulary
- `concept_names`: human-readable names parallel to concept_ids
- `vocabulary`: the dominant vocabulary in the result set (for display)

## Error modes

- `no_match` — return `concept_ids: []` and signal.
- `ambiguous` — return the most likely match with a flag in the response.
```

- [ ] **Step 3: Write `note-search.md`**

```markdown
# Tool: `note-search`

Search a patient's clinical notes by keyword or concept, returning ranked results.

## Signature

```
note-search(patient_id: string, query: string | { keywords: string[], concept_set?: int[] }, time_window?: { start: ISO8601, end: ISO8601 }, doc_types?: string[]) → ranked_results[]
```

## Behavior

- Searches the patient's full clinical note corpus.
- `query` may be a free-text query, a list of keywords, or a concept set.
- `time_window` filters by note authoring date.
- `doc_types` optionally restricts to specific document types (e.g., `["progress_note", "pathology_report"]`).
- Ranking is implementation-specific (BM25, dense retrieval, hybrid).

## Return shape

Each result:
- `note_id`: stable identifier
- `doc_type`: e.g., `progress_note`, `pathology_report`, `discharge_summary`
- `snippet`: a short excerpt around the strongest match (with character offsets in the parent note)
- `date`: note authoring date (ISO 8601)
- `score`: relevance score (implementation-specific scale)

## Error modes

- `patient_not_found` — return `[]` and signal.
- `query_invalid` — return `[]` and signal.
```

- [ ] **Step 4: Write `note-read.md`**

```markdown
# Tool: `note-read`

Retrieve a clinical note's full text plus its character offset map.

## Signature

```
note-read(note_id: string) → { full_text: string, offset_map: OffsetMap, metadata: NoteMetadata }
```

## Behavior

- Returns the note's complete text as a string.
- Returns an `offset_map` that callers can use to translate semantic structure to character offsets (e.g., section headers, paragraph breaks). Format is implementation-specific but must be stable for a given note_id.
- Returns `metadata`: doc_type, date, author_id, author_role, encounter_id, patient_id.

## Return shape

```
{
  full_text: string,
  offset_map: { sections: [{ name, start, end }], paragraphs: [{ start, end }] },
  metadata: { doc_type, date, author_id, author_role, encounter_id, patient_id }
}
```

## Error modes

- `note_not_found` — raise; this is a hard error because callers cite note_id directly.
```

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/interfaces/tools/
git commit -m "feat: add tool I/O specs (omop-query, concept-resolve, note-search, note-read)"
```

---

### Task 7: Author skill I/O template

**Files:**
- Create: `chart-review-platform/interfaces/skills/skill-template.md`

- [ ] **Step 1: Write the template**

```markdown
# Skill I/O Template

A skill is a reusable extraction procedure invoked by an agent to answer one chart review field. The contract fixes the I/O envelope; the skill's internals (model choice, retrieval strategy, prompt design) are implementation work.

## Skill file shape

Each skill is a markdown file with frontmatter:

```markdown
---
skill_id: <kebab-case-id>
applies_to:
  answer_schema: <criteria for matching, e.g., "type: number" or "enum: [met, not_met, ...]">
  source_preference: [omop, note]   # ordered preference list
  field_id_pattern: <optional regex>  # for skills targeting specific fields
description: <one sentence about when to use this skill>
---

# Skill: <human-readable name>

## When to use

<Plain-language description of which fields this skill answers well.>

## Procedure

<Steps the agent follows when invoking this skill.>

## Tool dependencies

- omop-query / concept-resolve / note-search / note-read
- ...
```

## Required input envelope

```
{
  field_id: string,
  answer_schema: <JSON Schema fragment from the field>,
  time_window: { id, start, end } | null,
  patient_id: string,
  extraction_guidance: string | null,
  manual_section: string | null   # the prose Definition / Examples / Source-priority block for this field
}
```

## Required output envelope

```
{
  answer: <validates against answer_schema>,
  evidence: [<evidence triple>, ...],
  alternatives_considered: [{ value, reason_rejected }],
  coverage: {
    notes_in_scope: int,
    notes_searched: int,
    notes_read_in_full: int,
    queries_run: [string],
    structured_queries_run: [string],
    excluded: [{ note_id, reason }]
  },
  applied_rule: string | null,
  confidence: "low" | "medium" | "high",
  missingness_reason: <enum, when applicable>,
  reasoning_summary: string | null   # audit-only; UI never displays on primary surface
}
```

## Quality bar

A skill output passes review iff:

1. `answer` validates against `answer_schema`.
2. Every quote in `evidence[].verbatim_quote` exists at the cited `span_offsets` in the corresponding note (faithfulness check).
3. `coverage.notes_searched` is non-zero unless the field is structured-only.
4. `confidence == low` whenever `evidence` is empty or single-source.

## Anti-patterns

- Free-form `reasoning_summary` shown to reviewers in primary UI (must be audit-only).
- Empty `coverage` for a field whose `answer == no_info` (the negative space must be explicit).
- Hallucinated values in `verbatim_quote` (auto-fail in faithfulness check; record-level rejection).
```

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/interfaces/skills/skill-template.md
git commit -m "feat: add skill I/O envelope template"
```

---

## Phase 2 — Backend prompt

The backend prompt is a single self-contained markdown file targeting a coding agent. It tells the agent to scaffold the deterministic library, synthetic adapter, and reference data — and assumes the canonical contracts and exemplar from Phase 1 are present in the same repository.

### Task 8: Backend prompt — frontmatter and goal

**Files:**
- Create: `chart-review-platform/prompts/backend-contract-kit-prompt.md`

- [ ] **Step 1: Write the header section**

Create the file with this exact opening block.

```markdown
# Prompt: Build the Chart Review Platform Backend Contract Kit

You are building the deterministic backbone of a configurable, human-in-the-loop EHR chart review platform. The platform is contract-first: a UI on one side and a (student-built) AI agent on the other side both talk to the same JSON contracts. Your job is the contract layer plus the deterministic library plus a synthetic-data adapter that lets the platform run end-to-end.

You are NOT building the AI agent. The agent's design — model choice, retrieval strategy, prompt structure, framework — is intentionally out of scope. Students will build it later, constrained only by the I/O contracts you ship.

## Reference materials in this repo

Read these before starting:

- `docs/superpowers/specs/2026-04-28-agentic-chart-review-design.md` — the platform design spec.
- `chart_review_task_literature_review.md` — the scoping review behind the design.
- `chart-review-platform/contracts/*.schema.json` — the canonical JSON Schemas (already authored). Treat these as immutable; if you find a problem, surface it before changing.
- `chart-review-platform/tasks/lung_cancer_phenotype.md` — the reference task document.
- `chart-review-platform/interfaces/tools/*.md` — tool I/O specs.
- `chart-review-platform/interfaces/skills/skill-template.md` — skill I/O envelope.

## What you will produce

A working Python package at `chart-review-platform/lib/`, plus reference adapters at `chart-review-platform/adapters/synthetic/` and synthetic data at `chart-review-platform/synthetic_data/`, that together let an external caller:

1. Compile any conforming task document (.md) into a CompiledTask JSON.
2. Validate any ReviewRecord JSON against the canonical schemas.
3. Evaluate derivation expressions and produce derived assessments + final output.
4. Run faithfulness checks against note text.
5. Detect cross-criterion alerts.
6. Run end-to-end against synthetic data with a stubbed agent that fills random plausible answers (for plumbing-test purposes).

Each subsystem is small, testable in isolation, and demonstrably working before the next one starts.

## Non-goals

- Real AI agent. (Out of scope; students.)
- Real EHR integration. (Synthetic data only; OMOP-on-DuckDB is a scaffold.)
- Web server. (CLI + library only.)
- Authentication, multi-tenancy. (Single user.)
```

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/backend-contract-kit-prompt.md
git commit -m "feat: backend prompt — header and goal"
```

---

### Task 9: Backend prompt — task document format section

- [ ] **Step 1: Append the task-document-format section**

Append to `chart-review-platform/prompts/backend-contract-kit-prompt.md`:

````markdown

## Task document format

A task document is a single markdown file combining the abstraction manual (prose) with the executable checklist schema (structured blocks). It is the source of truth for both humans and the platform.

### Frontmatter (required)

```yaml
---
task_id: <stable_id>
task_type: <free string>
review_unit: patient | encounter | episode | event
manual_version: <ISO date or semver>
index_anchor: <field id or task-level expression>
time_windows:
  - { id: <name>, anchor: <index_anchor or field>,
      start_offset: <duration>, end_offset: <duration> }
final_output: <field id with is_final_output: true>
---
```

### Body structure

- A single `# <Title>` H1 heading.
- A `## Overview` section with prose (referenced as `overview_prose` in the compiled output).
- One or more `## Field <id>` sections. The id is in backticks: `` ## Field `pathology_report_present` ``.

### Field section structure

Each field section begins with one fenced YAML code block defining the field's structure. Subsequent prose subsections (`### Definition`, `### Source-document priority`, `### Examples`, `### Tier rationale`, etc.) become `guidance_prose` keyed by lowercased section title.

```yaml
answer_schema: <JSON Schema fragment>
cardinality: one | many       # default: one
time_window: <window_id>      # optional
derivation: <expression>      # optional; if set, evidence not required
is_final_output: false        # default
extraction_guidance: "<short ops note>"
group: <free string>          # display-only
```

### Reference exemplar

`chart-review-platform/tasks/lung_cancer_phenotype.md` is the canonical example. The parser must compile it into a CompiledTask JSON that validates against `compiled_task.schema.json`. Use the exemplar as your fixture.
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/backend-contract-kit-prompt.md
git commit -m "feat: backend prompt — task document format section"
```

---

### Task 10: Backend prompt — deterministic library section

- [ ] **Step 1: Append the library section**

Append to the prompt file:

````markdown

## Deterministic library — modules and behaviors

Implement each module as its own subpackage under `chart-review-platform/lib/`. Each module ships with unit tests; tests must pass before moving to the next module.

### `lib/parser/`

Parses a task document (.md) into a `CompiledTask` dict. Behavior:

- Reads frontmatter using `python-frontmatter` or equivalent.
- Splits the body by `## Field <id>` headers (id captured from backticks).
- For each field, extracts the first ```` ```yaml ```` block as the structure block; parses it.
- For each subsequent `### <Section name>` heading inside the field, captures the prose and stores it under `guidance_prose[<normalized_key>]`. Normalization: lowercase, then replace spaces and hyphens with underscores. So `### Source-document priority` → `guidance_prose.source_document_priority`.
- Captures the `## Overview` body as `overview_prose`.
- Computes `source_document_sha` as SHA-256 of the raw markdown bytes.
- Returns a dict that validates against `contracts/compiled_task.schema.json`.

Tests must include:
- Compile `tasks/lung_cancer_phenotype.md` end-to-end and validate against the schema.
- Reject a frontmatter missing required fields with a clear error.
- Reject a field block missing `answer_schema` with a clear error.
- Round-trip preserve all 8 field ids in the exemplar.

### `lib/validator/`

Validates that an answer matches a field's `answer_schema`. Behavior:

- Uses `jsonschema` library to validate `answer` against `answer_schema`.
- Returns `{ status: "pass" | "fail", errors: [<message>, ...] }`.
- For derived fields with no `answer_schema.type` constraint, validation is bypassed (but a derivation must be present).

Tests:
- Pass: `{ enum: [met, not_met] }` with answer `"met"`.
- Fail: `{ enum: [met, not_met] }` with answer `"yes"`.
- Pass: `{ type: number, unit: "%" }` with answer `9.2`.

### `lib/derivation/`

Evaluates a derivation expression over filled field values. Behavior:

- Supports a small expression language: comparison (`==`, `!=`, `>`, `>=`, `<`, `<=`), Boolean (`AND`, `OR`, `NOT`), set membership (`in`), ternary (`<cond> ? <then> : <else>`), and string/number/boolean literals.
- Resolves bare field ids by looking them up in a provided `values: dict[field_id, value]`.
- Multi-line expressions (separated by colons inside ternaries) are flattened into a single expression for evaluation.
- Use `lark`, `pyparsing`, or a hand-written recursive-descent parser. Do NOT use `eval()`.

Tests:
- `"a == 'yes' AND b > 5"` with `{a: "yes", b: 7}` → `true`.
- The full `lung_cancer_status` derivation from the exemplar evaluates correctly across all 8 input combinations.
- Unknown field id raises a clear error.
- Reject expressions containing function calls or arbitrary Python.

### `lib/scheduler/`

Builds a dependency DAG of fields and yields them in evaluation order. Behavior:

- Leaf fields (no `derivation`) are evaluated first, in any order (independent).
- Derived fields wait until all field ids referenced in their derivation expression have values.
- Detect cycles and raise.

Tests:
- Exemplar yields a valid topological order with leaves first.
- A self-referential derivation raises `CycleError`.

### `lib/faithfulness/`

Verifies every evidence quote exists at its claimed offsets in the source note. Behavior:

- Input: a `CriterionAssessment.evidence` list + a function `get_note_text(note_id) → str`.
- For each `source: note` evidence, fetch the note text and check `text[start:end] == verbatim_quote`. Tolerate a small whitespace-normalization step (collapse runs of whitespace to single spaces on both sides) but report any mismatch.
- For each `source: omop` evidence, no verification (the contract only requires note-source verification).
- Return `{ status: "pass" | "partial" | "fail", details: [<message>, ...] }`. `partial` if some pass and some fail; `fail` if all fail.

Tests:
- Mock `get_note_text` returns "abc Adenocarcinoma of the lung xyz"; evidence has `verbatim_quote="Adenocarcinoma of the lung"` with offsets `[4, 30]` → `pass`.
- Wrong offsets → `fail`.
- Mixed pass/fail → `partial`.

### `lib/alerts/`

Detects cross-criterion contradictions auto-runnable on a ReviewRecord. Behavior:

- Loads a `CompiledTask` and a `ReviewRecord`.
- Runs a small library of registered detectors. Initial detector set:
  - `inconsistent_diagnosis_vs_lab`: warns when a diagnosis is recorded as `not_met` but a related lab value (looked up via field id mapping configured per task) is in the disease range.
  - `derivation_input_missing`: warns when a derived field's input is `no_info` or missing.
- Each detector emits `{ fields: [...], description, severity }`.
- For MVP, detectors are field-id-based and configured in the task document under a top-level `alerts:` frontmatter block. (This is a v1 minimal API; v2 will expose detector composition in the document body.)

Tests:
- Loaded test record with mismatched diagnosis-vs-lab triggers exactly one alert.
- Empty/clean record produces no alerts.

### Library packaging

- Use `pyproject.toml` with `setuptools` or `hatch`. Python ≥ 3.11.
- Pin dependencies: `jsonschema`, `pyyaml`, `python-frontmatter`, `lark` (or chosen parser lib), `pytest`.
- Python package importable as `chart_review` (note: hyphens not allowed in module names). Layout: `chart-review-platform/lib/chart_review/{parser,validator,derivation,scheduler,faithfulness,alerts,cli.py}/`. Install editable via `pyproject.toml` so the CLI runs anywhere.
- Single CLI entrypoint at `chart-review-platform/lib/chart_review/cli.py`:
  - `python -m chart_review compile <task.md>` → emits CompiledTask JSON to stdout.
  - `python -m chart_review validate <review_record.json>` → exits 0 if valid, 1 if not.
  - `python -m chart_review run <task.md> <patient_id> --agent stub` → end-to-end pipeline using the stub agent.
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/backend-contract-kit-prompt.md
git commit -m "feat: backend prompt — deterministic library section"
```

---

### Task 11: Backend prompt — synthetic data + adapter section

- [ ] **Step 1: Append the synthetic data section**

````markdown

## Synthetic data adapter

Build a deterministic synthetic-data adapter that lets the platform run end-to-end without a real EHR.

### Patient corpus

Generate 20 patients at `chart-review-platform/synthetic_data/`, named `patient_001` through `patient_020`. Cover the following lung cancer scenarios in roughly equal proportions:

- 5 patients with confirmed NSCLC (pathology + imaging + ICD + onc note)
- 3 patients with confirmed SCLC
- 4 patients with probable lung cancer (imaging + onc note, no pathology)
- 3 patients with ICD-only (C34.* code, no other supporting evidence)
- 5 patients with no lung cancer (some with benign nodules, some with no related findings)

Per patient, generate:

- An OMOP-shaped CSV bundle: `person.csv`, `condition_occurrence.csv`, `measurement.csv`, `drug_exposure.csv`, `procedure_occurrence.csv`, `visit_occurrence.csv`.
- 3–10 clinical notes as plain `.txt` files, with realistic doc types (progress_note, pathology_report, radiology_report, discharge_summary).
- A `metadata.json` per patient with: `patient_id`, ground-truth label for the lung cancer phenotype, expected per-field answers (used for evaluation, not for the agent).

Use a fixed random seed so the corpus is reproducible.

### Adapter implementations

`chart-review-platform/adapters/synthetic/` implements the four tool interfaces against the synthetic corpus:

- `omop-query` reads from the CSV bundles using DuckDB or pandas.
- `concept-resolve` reads from a small bundled `concepts.csv` (~50 concepts covering lung cancer ICD codes, common labs, common imaging procedures).
- `note-search` does a BM25 search over the patient's notes (use `rank_bm25` Python lib).
- `note-read` returns the .txt file content with character offsets.

Each adapter passes the same I/O contract tests defined in the interface spec files.

### Stub agent for plumbing tests

`chart-review-platform/adapters/synthetic/stub_agent.py` is a deliberately dumb agent used to test the platform's plumbing — NOT the agent students will eventually replace. It:

- For each leaf field, returns a deterministic answer based on the patient's metadata.json ground truth (so the platform pipeline runs cleanly).
- Generates plausible-looking evidence triples by picking a real note span containing a relevant keyword.
- Always reports `confidence: "medium"`.
- Is documented as a test fixture, with a banner comment: "DO NOT use this as an agent reference. It cheats by reading ground truth."

### Tests

- End-to-end test: `pytest tests/test_e2e.py` runs `compile → schedule → stub-agent → derive → faithfulness → alerts → validate` on each synthetic patient and asserts the final ReviewRecord validates against the schema and the final output matches the metadata's ground truth label.
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/backend-contract-kit-prompt.md
git commit -m "feat: backend prompt — synthetic data + adapter section"
```

---

### Task 12: Backend prompt — file layout and acceptance criteria

- [ ] **Step 1: Append the closing sections**

````markdown

## Final file layout

```
chart-review-platform/
├── contracts/                       # already authored, do not modify
│   ├── compiled_task.schema.json
│   ├── review_record.schema.json
│   ├── evidence.schema.json
│   └── trace.schema.json
├── tasks/                           # already authored
│   └── lung_cancer_phenotype.md
├── interfaces/                      # already authored
│   ├── tools/
│   └── skills/
├── lib/                             # YOUR WORK (Python package)
│   └── chart_review/
│       ├── parser/
│       ├── validator/
│       ├── derivation/
│       ├── scheduler/
│       ├── faithfulness/
│       ├── alerts/
│       └── cli.py
├── adapters/
│   └── synthetic/                   # YOUR WORK
│       ├── omop_query.py
│       ├── concept_resolve.py
│       ├── note_search.py
│       ├── note_read.py
│       └── stub_agent.py
├── synthetic_data/                  # YOUR WORK
│   └── patient_<id>/
│       ├── person.csv
│       ├── condition_occurrence.csv
│       ├── ...
│       ├── notes/<note_id>.txt
│       └── metadata.json
├── tests/                           # YOUR WORK
│   ├── test_parser.py
│   ├── test_validator.py
│   ├── test_derivation.py
│   ├── test_scheduler.py
│   ├── test_faithfulness.py
│   ├── test_alerts.py
│   ├── test_synthetic_adapter.py
│   └── test_e2e.py
├── pyproject.toml                   # YOUR WORK
└── README.md                        # YOUR WORK
```

## Acceptance criteria

The work is complete when ALL of the following hold. Verify each by running the listed command and checking output.

1. **Schemas unchanged.** `git diff chart-review-platform/contracts/` is empty.
2. **Exemplar compiles.** `python -m chart_review compile chart-review-platform/tasks/lung_cancer_phenotype.md` emits valid JSON that validates against `compiled_task.schema.json`.
3. **All unit tests pass.** `pytest chart-review-platform/tests/ -v` is green.
4. **End-to-end pipeline runs.** `python -m chart_review run chart-review-platform/tasks/lung_cancer_phenotype.md patient_001 --agent stub` emits a valid ReviewRecord that validates against `review_record.schema.json`. (Synthetic patient ids are `patient_001` through `patient_020`.)
5. **Stub agent recovers ground truth.** For all 20 synthetic patients, the e2e pipeline produces a final output matching `metadata.json`'s ground-truth label.
6. **Faithfulness check works.** Manually corrupt one evidence offset in the synthetic stub-agent output; the faithfulness check reports `partial` or `fail`.
7. **README documents** how a downstream user (e.g., a student) implements their own agent against the contracts. Include: where the schemas live, the skill envelope shape, how to run e2e against the synthetic corpus, and how to swap the stub agent for their own.

## Process expectations

- Test-driven: write the failing test, then the implementation. Commit after each green test.
- Small commits: one module's tests + implementation per commit.
- No premature optimization. Pandas + DuckDB for the synthetic adapter is fine; no need for indexed retrieval at this scale.
- No mocking the contract schemas. Run real validation against the real JSON Schema files.
- Document any contract issues you find before changing anything in `contracts/`.
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/backend-contract-kit-prompt.md
git commit -m "feat: backend prompt — file layout and acceptance criteria"
```

---

### Task 13: Review the backend prompt end-to-end

- [ ] **Step 1: Read the file top to bottom**

Run: `wc -l chart-review-platform/prompts/backend-contract-kit-prompt.md`
Expected: 250+ lines.

Open and read the file. Check for:

- Every section from this plan is present (header, format, library, synthetic data, file layout, acceptance criteria).
- Every required section/test/file mentioned has clear instructions.
- No `TBD`, `TODO`, `<placeholder>` text outside of YAML examples.
- File paths are consistent everywhere (`chart-review-platform/lib/...`, etc.).
- The 7 acceptance criteria are concrete and verifiable.

- [ ] **Step 2: Fix any inconsistencies inline**

Edit the file to resolve anything found in Step 1. Common issues to look for: drift between `chart_review` (Python module name) and `chart-review-platform` (directory name), missing test files, references to undefined terms.

- [ ] **Step 3: Commit any fixes**

```bash
git add chart-review-platform/prompts/backend-contract-kit-prompt.md
git commit -m "fix: backend prompt review pass — consistency edits"
```

(If no fixes needed, skip the commit.)

---

## Phase 3 — Frontend prompt

The frontend prompt targets `claude design`. It tells Claude to build the reviewer UI as a self-contained prototype consuming the canonical contracts.

### Task 14: Frontend prompt — frontmatter and goal

**Files:**
- Create: `chart-review-platform/prompts/frontend-reviewer-ui-prompt.md`

- [ ] **Step 1: Write the header**

```markdown
# Prompt: Build the Validation-First Reviewer UI for Agentic Chart Review

You are designing and building a single-page web application that lets a clinician-reviewer validate the output of an AI chart review agent against a patient's chart. The UI is the **primary defense** against the failure modes the literature documents (automation bias, coherent-but-wrong rationales, hallucinated evidence). Its job is to make the chart accessible for verification — NOT to make the agent's reasoning persuasive.

## What this UI is for

The reviewer's task is to verify, per criterion, that the agent's answer is correct against the chart. The five sub-tasks of validation:

1. **Did the agent answer the right question?** (manual section visible)
2. **Did the agent find the right evidence?** (evidence shown in source-note context)
3. **Did the agent miss evidence?** (coverage panel + reviewer's own search)
4. **Did the agent interpret the evidence correctly?** (structured alternatives_considered)
5. **Did the agent apply the right rule?** (applied_rule visible)

The UI must support all five.

## Reference materials in this repo

- `docs/superpowers/specs/2026-04-28-agentic-chart-review-design.md` — design spec, especially section 8 ("Validation-first UI design").
- `chart-review-platform/contracts/compiled_task.schema.json` — input shape #1.
- `chart-review-platform/contracts/review_record.schema.json` — input shape #2.
- `chart-review-platform/contracts/evidence.schema.json` — sub-shape used in both.
- `chart-review-platform/tasks/lung_cancer_phenotype.md` — the exemplar task; render it as the demo case.

## Tech stack

- React 18 + TypeScript.
- Tailwind CSS for styling. Default visual feel: clinical, dense, calm. Avoid playful or marketing-app aesthetics. Aim closer to Linear or Notion than Stripe or Vercel.
- No global state library; React context + reducers are enough.
- No backend; the prototype reads JSON fixtures from `/public/fixtures/`.

## Non-goals

- Authentication, multi-user, real-time collaboration.
- Real EHR integration — fixtures only.
- Adjudication / dual-review workflow (deferred to v2; this is single-reviewer).
- Manual versioning UI (deferred).
```

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/frontend-reviewer-ui-prompt.md
git commit -m "feat: frontend prompt — header and goal"
```

---

### Task 15: Frontend prompt — data shapes section

- [ ] **Step 1: Append the data shapes section**

````markdown

## Data the UI consumes

The UI reads three JSON files plus a synthetic note corpus:

1. `/public/fixtures/compiled_task.json` — the parsed task document. Validates against `contracts/compiled_task.schema.json`.
2. `/public/fixtures/review_record.json` — the agent's output for one patient. Validates against `contracts/review_record.schema.json`.
3. `/public/fixtures/notes/<note_id>.txt` — the full text of each note referenced by evidence triples.
4. `/public/fixtures/notes_metadata.json` — `{ note_id: { doc_type, date, author_role, ... } }`.

Generate one realistic fixture set as part of the deliverable, using the lung cancer exemplar's task and a fictional patient with mixed evidence (some confirmed, some `no_info`, at least one cross-criterion alert, at least one faithfulness `partial`).

## TypeScript types

Generate types from the JSON Schemas (or hand-write them, kept in sync). Key shapes:

```ts
type CompiledTask = {
  task_id: string;
  task_type?: string;
  review_unit: "patient" | "encounter" | "episode" | "event";
  manual_version: string;
  source_document_sha: string;
  index_anchor?: string;
  time_windows?: { id: string; anchor: string; start_offset: string; end_offset: string }[];
  final_output?: string;
  overview_prose?: string;
  fields: Field[];
};

type Field = {
  id: string;
  prompt?: string;
  answer_schema: object;
  cardinality?: "one" | "many";
  time_window?: string;
  derivation?: string;
  is_final_output?: boolean;
  extraction_guidance?: string;
  group?: string;
  guidance_prose?: { definition?: string; source_document_priority?: string; examples?: string; [k: string]: string | undefined };
};

type Evidence =
  | { source: "note"; note_id: string; doc_type?: string; span_offsets: [number, number]; verbatim_quote: string; evidence_date: string; author_role?: string }
  | { source: "omop"; table: string; row_id: string | number; concept_id?: number; concept_name?: string; value?: unknown; unit?: string; evidence_date: string };

type CriterionAssessment = {
  field_id: string;
  answer: unknown;
  evidence: Evidence[];
  alternatives_considered?: { value: unknown; reason_rejected: string }[];
  coverage: {
    notes_in_scope: number;
    notes_searched: number;
    notes_read_in_full?: number;
    queries_run: string[];
    structured_queries_run?: string[];
    excluded?: { note_id: string; reason: string }[];
  };
  applied_rule?: string | null;
  confidence: "low" | "medium" | "high";
  missingness_reason?: string;
  faithfulness_check?: { status: "pass" | "partial" | "fail"; details?: string[] };
  schema_validation?: { status: "pass" | "fail"; errors?: string[] };
  trace_summary?: { skills_invoked: string[]; tools_used: { tool: string; n_calls: number }[] };
};

type ReviewRecord = {
  record_id: string;
  task_document_sha: string;
  review_unit_id: string;
  patient_id: string;
  task_metadata_snapshot: object;
  started_at: string;
  completed_at?: string;
  criterion_assessments: CriterionAssessment[];
  derived_assessments?: { field_id: string; value: unknown; derivation_inputs: { field_id: string; value: unknown }[] }[];
  cross_criterion_alerts?: { fields: string[]; description: string; severity: "info" | "warning" | "error" }[];
  final_output?: { field_id: string; value: unknown; derivation_chain?: string[] };
  audit_trail: AuditEntry[];
  reviewer_overrides?: ReviewerOverride[];
};

type ReviewerOverride = {
  field_id: string;
  original_value: unknown;
  corrected_value: unknown;
  supporting_evidence?: Evidence[];
  error_category: "missed_evidence" | "misinterpreted" | "wrong_rule" | "criterion_ambiguous" | "other";
  free_text?: string;
  reviewer_id: string;
  timestamp: string;
};
```
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/frontend-reviewer-ui-prompt.md
git commit -m "feat: frontend prompt — data shapes section"
```

---

### Task 16: Frontend prompt — three-pane layout section

- [ ] **Step 1: Append the layout section**

````markdown

## Layout: three panes

Single-page case-review view. No tabs, no modals on the primary surface (audit log is a separate route).

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Header: Patient ID • Task title • Status • [Approve all] [Audit log ▸]  │
├──────────────┬──────────────────────────────┬────────────────────────────┤
│ Left pane    │ Middle pane                  │ Right pane (largest, 50%)  │
│ ~20%         │ ~30%                         │                            │
│              │                              │                            │
│ Criterion    │ ACTIVE CRITERION             │ Source-note viewer         │
│ list         │                              │                            │
│ - id         │ Field id + prompt            │ Currently displayed note:  │
│ - status icon│                              │   doc_type, date, author   │
│ - confidence │ Manual section (collapsible) │                            │
│ - alerts     │                              │ Full text with cited spans │
│              │ Answer panel                 │ highlighted in place.      │
│ Workflow:    │   - the answer               │                            │
│ - Next       │   - confidence badge         │ Reviewer can scroll        │
│ - Prev       │   - faithfulness badge       │ independently to scan for  │
│ - Skip       │                              │ missed evidence.           │
│              │ Evidence list                │                            │
│ Cross-       │   Click → highlights in note │ Toolbar:                   │
│ criterion    │                              │ - search this note         │
│ alerts       │ Alternatives considered      │ - jump to evidence #N      │
│ panel        │ (structured, bounded)        │ - switch note ▾            │
│ (warnings)   │                              │                            │
│              │ Coverage panel               │                            │
│              │   - notes in scope: 47       │                            │
│              │   - notes searched: 47       │                            │
│              │   - read in full: 3          │                            │
│              │   - queries: [...]           │                            │
│              │   - excluded: ▸              │                            │
│              │                              │                            │
│              │ Applied rule                 │                            │
│              │                              │                            │
│              │ [Search chart yourself]      │                            │
│              │                              │                            │
│              │ Override controls:           │                            │
│              │ [Approve] [Override...]      │                            │
└──────────────┴──────────────────────────────┴────────────────────────────┘
```

### Routing

- `/case/:patientId` — the three-pane review view (the main view).
- `/case/:patientId/audit` — the audit-log view (Layer 3, separate route).
- `/` — case list (read fixtures from `/public/fixtures/cases.json`).

### Keyboard shortcuts (must implement)

- `j` / `k` — next / previous criterion
- `Enter` — approve current criterion
- `o` — open override dialog
- `s` — focus the reviewer-search input
- `g` then `a` — open the audit log
- `?` — show shortcut help overlay
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/frontend-reviewer-ui-prompt.md
git commit -m "feat: frontend prompt — three-pane layout section"
```

---

### Task 17: Frontend prompt — primary surface details

- [ ] **Step 1: Append the primary surface section**

````markdown

## Primary surface — what's always visible per criterion

These elements live in the middle pane and are never hidden by default. Each is a distinct subcomponent.

### Field header

- Large field id in monospace.
- Subtitle: `field.prompt` (one-line description).
- Status badge: ✓ approved / ⚠ overridden / ▶ pending.
- Group tag (small pill).

### Manual section (`guidance_prose`)

- Collapsible (defaults to expanded for the active criterion).
- Renders `definition` first, then `source_document_priority`, then `examples`, then any other prose sections in document order.
- Markdown-rendered (use `react-markdown`).

### Answer panel

- The agent's answer in a prominent typed display: enum value as a pill, number with unit, date with precision, etc.
- Confidence badge: low / medium / high (color-graded; low is amber, high is green; medium is neutral).
- Faithfulness badge: shown only when status is `partial` or `fail`. `pass` is silent. (Don't bother the reviewer with green checkmarks.)
- Schema-validation badge: shown only on `fail`.
- Missingness reason badge: shown when answer is a "no info" / equivalent enum.

### Evidence list

- Each evidence triple as a row.
- `note` source: doc_type pill, date, verbatim quote in a quote block. Click → right pane scrolls to and highlights the span.
- `omop` source: table pill, concept_name (with concept_id tooltip), value/unit, date. Click → opens a small inline preview (no source-note pane involvement).
- Provide an "n more not shown" affordance if there are >5 evidence items.

### Alternatives considered

- Bounded structured display, not a textarea.
- Each alternative as: `value → reason rejected`.
- If empty, show: "No alternatives considered" (neutral, not an error).

### Coverage panel

- Compact stats row: `47 in scope • 47 searched • 3 read in full`.
- Expandable details: queries run (badges), structured queries run, excluded notes (with reason per note, click → opens that note in the right pane).
- The "[Search chart yourself]" button opens an inline search input that calls a stubbed search function over the fixture notes (use the same simple search the synthetic adapter would use; this fixture-side implementation can be a string-includes + ranking-by-frequency).

### Applied rule

- Show the rule id and a tooltip pointing to the manual section that defines it.
- If `null`, show "No rule applied" subtly.

### Override controls

- Primary action: `[Approve]` (large, default).
- Secondary: `[Override…]` opens an inline form, NOT a modal.
  - Fields in the override form: corrected value (typed input matching `answer_schema`), supporting evidence (multi-select from list of evidence already shown + "search and add"), error category (required radio: missed_evidence / misinterpreted / wrong_rule / criterion_ambiguous / other), free text (optional textarea).
  - Submit creates a `ReviewerOverride` and updates the criterion's display.
- "Skip / decide later" tertiary action.
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/frontend-reviewer-ui-prompt.md
git commit -m "feat: frontend prompt — primary surface details"
```

---

### Task 18: Frontend prompt — source-note viewer details

- [ ] **Step 1: Append the source-note section**

````markdown

## Right pane: source-note viewer

This is the largest pane and the most important interactive surface in the app.

### Behavior

- Loads the full text of the active note from `/public/fixtures/notes/<note_id>.txt`.
- Renders text in a monospace or readable serif (your call) at a comfortable reading size — `text-base` or `text-sm` Tailwind, line-height ≥ 1.6.
- Highlights the cited spans for the active criterion's evidence with a colored background.
- When the user clicks an evidence row in the middle pane, the source-note viewer scrolls to that span and pulses its highlight briefly to draw the eye.
- The user can scroll the note independently to scan for missed evidence.

### Highlighting

- Use `<mark>` or a styled `<span>`. Multiple highlights on the same note simultaneously is fine; each highlight should be numbered to match the evidence list ordering.
- On hover over a highlight, show a small tooltip with the field id and the verbatim quote (if it differs from the note text — i.e., when whitespace-normalized the agent's quote was the same but the on-screen text shows the original).

### Toolbar

- Note switcher (dropdown showing all notes for the patient with doc_type and date).
- "Search this note" inline input. Highlights matches in a different color than evidence highlights.
- "Jump to evidence" select (lists the active criterion's evidence by number).

### Edge cases

- Note has no cited evidence for the active criterion: show the note plain, with a banner: "No evidence cited from this note for this criterion."
- Active criterion has no note evidence at all (only OMOP): show a different banner: "All evidence for this criterion comes from structured data. Browse notes manually using the switcher."
- A cited offset doesn't match the note text (faithfulness `fail`): highlight the offset range in red and show a clear inline error: "Cited quote does not match note at this offset."
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/frontend-reviewer-ui-prompt.md
git commit -m "feat: frontend prompt — source-note viewer details"
```

---

### Task 19: Frontend prompt — left pane (criterion list + alerts)

- [ ] **Step 1: Append the left pane section**

````markdown

## Left pane: criterion list and cross-criterion alerts

### Criterion list

- One row per field in the task, ordered by the document order of the task fields.
- Each row shows: status icon, field id, group tag, confidence dot, alert flag (when this field appears in any cross_criterion_alerts).
- Active row is visually emphasized.
- Click → makes that criterion active (updates middle and right panes).
- Derived fields are visually distinct (e.g., italic + a small "Δ" badge) and clicking them shows a derivation view in the middle pane (see below).

### Status icons

- `✓` approved (or untouched + matches schema + faithfulness pass)
- `⚠` overridden by reviewer
- `▶` currently active
- `!` faithfulness failed
- `?` low confidence
- (No icon) not yet visited / pending

### Cross-criterion alerts panel

- Below the criterion list. Always visible if any alerts exist.
- One row per alert: severity icon, fields involved (clickable chips that jump to that criterion), description.
- Severity color: error (red), warning (amber), info (blue).
- Empty state: "No cross-criterion alerts." (small, gray)

### Derivation view in middle pane (when a derived field is active)

When the user clicks a derived field, the middle pane shows a different layout:

- The derivation expression as a syntax-highlighted code block.
- The input fields with their resolved values (clickable, jumps to that input).
- The computed output value.
- No evidence list (derived fields don't have evidence). Replace with a "Derivation provenance" section showing the inputs.
- Override controls work the same way (override the derived value if the reviewer disagrees with the rule's outcome).
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/frontend-reviewer-ui-prompt.md
git commit -m "feat: frontend prompt — left pane criterion list and alerts"
```

---

### Task 20: Frontend prompt — secondary and tertiary surfaces

- [ ] **Step 1: Append the secondary/tertiary surface section**

````markdown

## Secondary surface: per-criterion expanded trace

Hidden by default per criterion, accessible via a "Show trace summary ▾" toggle at the bottom of the active criterion view. Auto-expanded when confidence is `low` OR faithfulness check fails.

Contents:

- `trace_summary.skills_invoked` as a list of skill ids.
- `trace_summary.tools_used` as a small bar chart (tool name → call count).
- A more detailed differential, if available, showing each rejected alternative with its evidence (if any).
- Faithfulness check `details` (when the status was `partial` or `fail`).

This surface is for **investigating** a specific answer, not for routine review. Don't auto-expand globally.

## Tertiary surface: audit log view

Separate route at `/case/:patientId/audit`. Full forensic log. Used for:

- Re-adjudication
- Post-hoc analysis
- Debugging an agent run
- Building training data for the learning loop (v2)

### Layout

A vertically scrolling timeline of `AuditEntry` items. Each item:

- Timestamp (left rail).
- Step type as a colored pill (`plan`, `tool_call`, `tool_result`, `skill_invocation`, `skill_result`, `answer`, `self_check`, `override`).
- Payload as expandable JSON (use a collapsed JSON tree component; default depth 1).
- Model / prompt / skill / tool versions in a small footer line.

### Filters

- By step_type (multi-select).
- By field_id (when the entry's payload includes a field_id).
- By time range.

### Search

- Free-text search over payload JSON. Highlights matches.

### Free-form reasoning

`reasoning_summary` from criterion assessments is shown ONLY in this view, never on the primary surface. Display each reasoning_summary in a clearly labeled "Agent reasoning (not for primary review)" block tied to its criterion entry. Include a one-line warning at the top of the audit view: "This view contains the agent's free-form reasoning. Do not use to validate answers — coherent reasoning does not imply correct answers."

## Blinded first pass (optional toggle)

A header-bar toggle: `[ ] Blinded review` (default off).

When on:

- The agent's `answer`, `confidence`, `evidence`, `alternatives_considered`, and `applied_rule` are hidden in the middle pane.
- The reviewer fills in their own answer + evidence first using the source-note viewer and reviewer search.
- After the reviewer submits, the agent's hidden values are revealed inline below the reviewer's, with a side-by-side diff.
- A note is added to the override record if the reviewer's answer differs from the agent's, even without a manual override action.

When off, behaves as primary surface above.
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/frontend-reviewer-ui-prompt.md
git commit -m "feat: frontend prompt — secondary, tertiary, and blinded-pass surfaces"
```

---

### Task 21: Frontend prompt — visual style notes

- [ ] **Step 1: Append the style section**

````markdown

## Visual style and interaction polish

### Density and rhythm

- Compact but breathable. Reviewers will spend hours in this UI; both fatigue from cramping and fatigue from excess scrolling are real. Aim for the density of Linear or Notion's table-row views.
- Use a consistent vertical rhythm (8px or 4px grid).
- Headlines: clear, no decorative variation.

### Color

- Calm neutrals as the base. Reserve color for status (success / warning / error), highlights (evidence in source note), and confidence grading.
- Avoid gradient fills, large color blocks, marketing-style splash graphics.
- Dark mode is a stretch; light mode first.

### Typography

- A single sans-serif for UI (Inter or system). A monospace for field ids and code (Berkeley Mono fallback to ui-monospace).
- Body text 14–15px. Field ids and tags slightly smaller and monospace.

### Highlights in source notes

- Default highlight: soft amber background with subtle left-border accent.
- Active highlight (the one the reviewer just clicked): brighter amber + brief CSS pulse animation (~600ms).
- Faithfulness-failed highlights: red background with a small ⚠ icon at the start.

### Don't

- No animations on entry / hover that aren't strictly informational. Reviewers will see them thousands of times.
- No tooltips that hide critical information; tooltips are for additive detail.
- No confirmation modals for routine actions (Approve, Skip). Override is non-destructive enough that confirm dialogs would just slow things down. (Audit-log writeback happens on every action regardless.)
- No marketing copy. No emojis in UI text. No exclamation marks.
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/frontend-reviewer-ui-prompt.md
git commit -m "feat: frontend prompt — visual style notes"
```

---

### Task 22: Frontend prompt — fixtures and acceptance criteria

- [ ] **Step 1: Append the fixtures + acceptance section**

````markdown

## Fixtures to generate

You must generate the demo fixtures yourself. Place them under `public/fixtures/`.

1. `compiled_task.json` — the parsed lung_cancer_phenotype.md (you can author this by hand from the task document).
2. `review_record.json` — a realistic record for one fictional patient. Must include:
   - All 5 leaf fields filled with `confidence` varying low / medium / high.
   - At least one `no_info` answer with explicit `coverage` showing the negative space.
   - At least one `faithfulness_check.status: "partial"` with `details` populated.
   - One `cross_criterion_alert` (use the `derivation_input_missing` detector — e.g., a derived field whose input is `no_info`).
   - 3+ evidence triples per filled field, mixing `note` and `omop` sources.
   - A populated `audit_trail` with at least 30 entries spanning all `step_type` values.
3. `notes/<note_id>.txt` — the note files cited by the evidence. At least 5 distinct notes. One should contain the cited span at slightly different whitespace from the agent's quote (to demonstrate whitespace-normalization in the faithfulness viewer). One should have a deliberate offset error to show the failed-faithfulness UI state.
4. `notes_metadata.json` — metadata for each note.
5. `cases.json` — a single-entry list pointing at the fictional patient (so the case-list page is meaningful).

## Acceptance criteria

The work is complete when ALL of the following hold.

1. **Three-pane layout** renders for the demo case, with all elements from the layout section visible without horizontal scrolling at 1440px viewport.
2. **Click any evidence quote** → right pane scrolls to and highlights the span.
3. **Click an evidence with a wrong offset** → faithfulness-failed UI shows correctly.
4. **Click a derived field** in the left pane → middle pane shows the derivation view (no evidence list).
5. **Cross-criterion alert** is visible in the left pane and clicking its field chip jumps the active criterion.
6. **Coverage panel** shows the negative space (notes in scope vs. searched vs. excluded) and the "Search chart yourself" affordance opens an inline search.
7. **Override flow**: opening Override on any criterion shows the inline form with all required fields; submitting writes a `ReviewerOverride` to in-memory state and updates the row's status icon.
8. **Audit log route** (`/case/.../audit`) shows the timeline with filters, search, and the agent-reasoning warning banner.
9. **Blinded review toggle** in the header hides answer/confidence/evidence in the middle pane until the reviewer submits, then reveals with a diff.
10. **Keyboard shortcuts** all work: `j`/`k`, `Enter`, `o`, `s`, `g a`, `?`.
11. **No primary-surface display** of `reasoning_summary` (verify by visiting both criteria and the audit log).
12. **No console errors or warnings** in a fresh page load.

## What "done" looks like in the deliverable

- A runnable Vite + React + TypeScript app.
- `npm install && npm run dev` opens the demo case at `localhost:5173/case/demo-patient`.
- All fixtures included.
- A short `README.md` with run instructions and pointers to where each acceptance-criterion behavior is implemented (file path + component name).
````

- [ ] **Step 2: Commit**

```bash
git add chart-review-platform/prompts/frontend-reviewer-ui-prompt.md
git commit -m "feat: frontend prompt — fixtures and acceptance criteria"
```

---

### Task 23: Review the frontend prompt end-to-end

- [ ] **Step 1: Read the file top to bottom**

Run: `wc -l chart-review-platform/prompts/frontend-reviewer-ui-prompt.md`
Expected: 250+ lines.

Open and read. Check for:

- All five validation sub-tasks are addressed by named UI features.
- Every piece of `ReviewRecord` data has a corresponding UI element (or is explicitly audit-only).
- No surface uses `reasoning_summary` outside the audit log.
- Acceptance criteria are concrete and testable manually.
- Routing, keyboard shortcuts, and fixtures are consistent across sections.
- Tech stack mentions are consistent (React 18 + TypeScript + Tailwind + Vite).

- [ ] **Step 2: Fix any inconsistencies inline**

Edit the file to resolve issues found.

- [ ] **Step 3: Commit any fixes**

```bash
git add chart-review-platform/prompts/frontend-reviewer-ui-prompt.md
git commit -m "fix: frontend prompt review pass — consistency edits"
```

(If no fixes needed, skip the commit.)

---

## Phase 4 — Plan-level review

### Task 24: End-to-end plan review

- [ ] **Step 1: Verify both prompts can be run independently**

Read both prompts back-to-back. Check:

- The backend prompt nowhere depends on the frontend's existence.
- The frontend prompt nowhere depends on the backend prompt being run first (it has its own fixtures specified).
- Both prompts reference the same canonical contract files at the same paths.
- Both prompts cite `lung_cancer_phenotype.md` consistently.

- [ ] **Step 2: Verify the spec is fully covered**

Open `docs/superpowers/specs/2026-04-28-agentic-chart-review-design.md` side by side with the artifacts. For each spec section, confirm there's a corresponding artifact:

- Section 4 (task document format) → backend prompt + lung_cancer_phenotype.md exemplar
- Section 5 (uniform field shape) → compiled_task.schema.json + exemplar
- Section 6 (data substrate, two-flavor evidence) → evidence.schema.json + tool I/O specs + synthetic adapter section
- Section 7 (ReviewRecord) → review_record.schema.json + backend prompt's library section
- Section 8 (validation-first UI, six features, three layers) → frontend prompt's primary/secondary/tertiary surface sections
- Section 9 (file layout) → backend prompt + frontend prompt produce the layout
- Section 10 (two-prompt deliverable) → this plan produces both
- Section 11 (open questions) → noted but not built; that's expected

- [ ] **Step 3: Commit any final fixes**

If anything is missing, add it inline to the relevant prompt and commit.

```bash
git add chart-review-platform/
git commit -m "fix: plan-level review pass"
```

(Skip if no fixes needed.)

---

## Self-review checklist (run after writing the plan, before handing off)

- [ ] Spec coverage: every spec section maps to a task above. Confirmed in Task 24, Step 2.
- [ ] No `TBD`, `TODO`, or unspecified placeholder text outside of YAML/JSON schema defaults.
- [ ] File paths are consistent: `chart-review-platform/...` everywhere, no drift.
- [ ] Schema `$ref`s resolve (relative paths between schema files are correct).
- [ ] Both prompts are self-contained (each can be run without the other).
- [ ] All acceptance criteria are concrete and verifiable by a command or visual check.
