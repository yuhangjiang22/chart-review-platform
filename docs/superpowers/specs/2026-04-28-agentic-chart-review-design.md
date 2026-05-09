# Agentic EHR Chart Review — Platform Design

**Date**: 2026-04-28
**Status**: Draft (post-brainstorm)
**Related**:
- `chart_review_task_literature_review.md` — scoping review (2026-04-27)
- `prompt.md` — lit-review prompt

---

## 1. Goal

Build a generic, configurable, human-in-the-loop platform for AI-assisted EHR chart review. The platform consumes a **task document** (combined manual + checklist) and produces a structured **ReviewRecord** that a human reviewer validates through a UI. Use cases (phenotype validation, trial eligibility screening, outcome adjudication, registry abstraction, etc.) are loaded as task documents — no platform changes per use case.

The brainstorm converged on a **contract-first, three-layer architecture** that decouples:

- **What is reviewed** — captured in a task document (single markdown file combining prose guideline + structured field schema).
- **How an agent fills the checklist** — left to students / researchers; only the I/O contract is fixed.
- **How a human reviews the result** — a frontend that consumes the contract.

## 2. Scope

### In MVP

- Single-reviewer workflow.
- Configurable platform driven by task documents (no code change per use case).
- Per-criterion answers with evidence triples, confidence, missingness reasons.
- **Faithfulness check**: verify quoted spans exist at cited offsets.
- **Multi-source evidence**: OMOP structured + free-text notes.
- Synthetic-data adapter for prototyping; OMOP-on-DuckDB adapter scaffolded.
- **Three-layer trace exposure**: validation surface, on-demand expansion, audit log.
- Reference exemplar: `lung_cancer_phenotype.md`.
- Deterministic library for parsing, schema validation, derivation evaluation, scheduling, faithfulness verification, cross-criterion alerts.
- Reviewer override capture with structured error categorization.

### Deferred (explicitly v2 or later)

- Dual review and adjudication workflow (lit-review schema retained; no UI surface in MVP).
- Manual-versioning UI (versioning happens via document SHAs; surfacing diffs is v2).
- Learning loop / corrections-to-skills feedback (override capture is the substrate; the loop is v2).
- Criterion evolution (agent proposing checklist refinements).
- FHIR adapter (interface seam left open; adapter not in MVP).
- Production authn/authz, multi-user concurrency, enterprise EHR integration.

## 3. Architecture

```
┌──────────────────────────────────┐
│ Reviewer UI (frontend prototype) │
│ - reads compiled task            │
│ - reads ReviewRecord             │
│ - writes overrides + audit       │
└──────────────┬───────────────────┘
               │ JSON contract
┌──────────────┴───────────────────┐
│ Contract layer (this spec)       │
│ - task document format           │
│ - compiled task JSON Schema      │
│ - ReviewRecord JSON Schema       │
│ - tool / skill I/O specs         │
│ - parser + validator + derivation│
│ - faithfulness + alerts utils    │
└──────────────┬───────────────────┘
               │ produces ReviewRecord
┌──────────────┴───────────────────┐
│ Agent layer (student work)       │
│ - chosen framework (DeepAgents,  │
│   Claude Agent SDK, etc.)        │
│ - skills implementing extraction │
│ - tools accessing data           │
└──────────────────────────────────┘
```

**Decoupling principle.** UI and agent never talk directly. Both talk to the contract.

- A new use case = a new task document; no agent change.
- A new agent = a new project that produces a valid ReviewRecord; no UI change.
- The contract is the only artifact the team owns end-to-end.

## 4. Task document format

A task document is a single markdown file combining the abstraction manual (prose) with the executable checklist schema (structured blocks). It is the source of truth for both humans (who read it) and the platform (which compiles it).

### Layout

````markdown
---
task_id: <stable_id>
task_type: <free string; informational only>
review_unit: patient | encounter | episode | event
manual_version: <ISO date or semver>
index_anchor: <field id, or task-level expression>
time_windows:
  - { id: <name>, anchor: <index_anchor or field>,
      start_offset: <duration>, end_offset: <duration> }
final_output: <field id with is_final_output: true>
---

# <Task title>

## Overview
<Prose: when this task applies, scoping notes, source-document priority,
high-level decision logic. Read once by the agent at session start.>

## Field `<id>`

```yaml
answer_schema: <JSON Schema fragment>
cardinality: one | many
time_window: <window_id>             # optional
derivation: <expression>             # optional; if set, evidence_required = false
is_final_output: false               # default
extraction_guidance: "<short ops note pointing to manual section>"
group: <free string>                 # display-only
```

### Definition
<Prose: what counts, what doesn't, edge cases.>

### Source-document priority
<Ordered list, when applicable.>

### Examples
- "<verbatim quote>" → `<answer>`
- ...

(repeat per field)
````

### Compilation

A deterministic parser (shipped) extracts:

- Frontmatter → task metadata.
- Each `## Field <id>` block's first fenced YAML → field structure.
- Subsequent prose under the field heading → field guidance, addressable by field id.

The compiled output (`compiled_task.json`) is what the runtime, agent, and UI consume. The markdown is the source of truth; the compiled JSON is a derived view, regenerated on every change. Each ReviewRecord pins to the source document's content hash.

## 5. Schema model — uniform field shape

Every field has the same top-level shape. Predicate criteria, value extractions, derived computations, and final labels all collapse into one shape; their differences are expressed in `answer_schema` and `derivation`, not in distinct types.

| Concept | Expressed as |
|---|---|
| Predicate (met / not_met / no_info / N/A) | `answer_schema: { enum: [met, not_met, no_info, not_applicable] }` |
| Numeric value | `answer_schema: { type: number, unit: ... }` |
| Date with precision | `answer_schema: { type: date, precision: day\|month\|year }` |
| Coded value | `answer_schema: { type: string, vocabulary: <code system> }` |
| Severity grade | `answer_schema: { enum: [...] }` |
| Derived | `derivation: <expression>`; evidence not required |
| Final label / score | `derivation: ...` + `is_final_output: true` |

### Composition rule

Atomic fields are answered from direct chart evidence. Composite logic is expressed by **derived fields** with a `derivation` over other fields' values. The "criterion within criterion" recursion bottoms out here: every leaf is a chart-readable extraction; everything else is a rule over leaves. Sub-tasks (one task's output feeding another) are explicitly v2.

### Time windows + index anchor

Declared once at the task level. Fields reference a window by id. The index anchor is either a task-level expression or a designated field that defines time-zero for the patient.

## 6. Data substrate

The platform supports both OMOP-formatted structured data and free-text clinical notes. Evidence triples carry the source flavor.

```yaml
evidence:
  # Either:
  - source: note
    note_id, doc_type, span_offsets: [start, end],
    verbatim_quote, evidence_date, author_role
  # Or:
  - source: omop
    table, row_id, concept_id, concept_name,
    value, unit, evidence_date
```

A single criterion answer can carry both source flavors. "Patient has T2DM" can cite an `E11.9` row in CONDITION_OCCURRENCE *and* a progress-note span — that is a stronger answer than either alone.

### Tool I/O contracts (signatures fixed; implementations are student work)

- `omop-query(patient_id, concept_set, time_window) → row[]`
- `concept-resolve(concept_name | definition) → code_set`
- `note-search(patient_id, query, time_window) → ranked_results[{note_id, doc_type, snippet, date}]`
- `note-read(note_id) → full_text + offset_map`

Two adapters in MVP:

- **Synthetic** — generated OMOP CSVs + generated notes for ~20 patients, baked into the repo. No DB, no IRB.
- **OMOP-on-DuckDB scaffold** — runs against any OMOP CDM CSV dump.

### Skill I/O contract (envelope fixed; internals are student work)

```yaml
input:
  field_id, answer_schema, time_window,
  patient_id, extraction_guidance, manual_section
output:
  answer:                        # matches answer_schema
  evidence: [evidence_triple, ...]
  alternatives_considered: [{ value, reason_rejected }]
  coverage:
    notes_in_scope: <int>
    notes_searched: <int>
    notes_read_in_full: <int>
    queries_run: [<string>, ...]
    structured_queries_run: [<string>, ...]
    excluded: [{ note_id, reason }]
  applied_rule: <string id from manual, or null>
  confidence: low | medium | high
  missingness_reason: <enum, when applicable>
  reasoning_summary: <free-form, optional, audit-only>
```

Internals — model choice, retrieval strategy, prompt design — are deliberately out of contract.

## 7. ReviewRecord — the agent's output contract

```yaml
review_record:
  record_id, task_document_sha, review_unit_id, patient_id
  task_metadata_snapshot       # frozen copy at review time
  started_at, completed_at

  criterion_assessments:
    - field_id
      answer
      evidence: [evidence_triple, ...]
      alternatives_considered: [...]
      coverage: {...}
      applied_rule
      confidence
      missingness_reason
      faithfulness_check: { status: pass | partial | fail, details: [...] }
      schema_validation: { status: pass | fail, errors: [...] }
      trace_summary:
        skills_invoked: [skill_id, ...]
        tools_used: [{ tool, n_calls }]

  derived_assessments:           # populated by deterministic derivation evaluator
    - field_id, value, derivation_inputs: [{ field_id, value }]

  cross_criterion_alerts:        # auto-detected by library
    - { fields: [...], description, severity }

  final_output:
    field_id, value, derivation_chain

  audit_trail:                   # Layer 3, forensic
    - { timestamp, step_type, payload, model_version,
        prompt_version, skill_version, tool_version }

  reviewer_overrides:            # populated by UI
    - field_id, original_value, corrected_value,
      supporting_evidence, error_category, free_text,
      reviewer_id, timestamp
```

The agent populates `criterion_assessments` and `audit_trail`. The library populates `derived_assessments`, `cross_criterion_alerts`, and `final_output`. The UI populates `reviewer_overrides`.

## 8. Validation-first UI design

The UI's job is to make the **chart** accessible for verification — not to make the **agent's reasoning** accessible. Reasoning supports debugging; chart access supports validation. This reframes most existing chart-review-AI UIs.

### Validation decomposes into five sub-tasks

1. **Did the agent answer the right question?** → field's manual section visible during review.
2. **Did the agent find the right evidence?** → evidence shown inside the source note, in context.
3. **Did the agent miss evidence?** → coverage panel exposing the negative space + reviewer's own search.
4. **Did the agent interpret evidence correctly?** → structured `alternatives_considered`.
5. **Did the agent apply the right rule?** → `applied_rule` visible per criterion.

### Six load-bearing UI features

1. **Source-note viewer with in-context highlighting** (the largest pane). Click any evidence quote → note opens, scrolls to span, highlights it. Reviewer can scroll independently to scan for missed evidence.
2. **Coverage panel** per criterion: notes in scope, notes searched, queries run, notes excluded with reason. Makes "no_info" verifiable.
3. **Independent reviewer search** across the patient's chart (uses the same tools the agent uses).
4. **Cross-criterion consistency alerts** auto-computed by the library and surfaced prominently.
5. **Field-specific manual section embedded** in the active criterion view.
6. **Structured override capture**: corrected value + supporting evidence + error category (enum: `missed_evidence` | `misinterpreted` | `wrong_rule` | `criterion_ambiguous` | `other`) + optional free text.

### Three exposure layers

| Surface | Purpose | Contents |
|---|---|---|
| **Primary (always visible)** | Validate against the chart | Answer + evidence-in-context + manual section + coverage + alternatives + applied rule + cross-criterion alerts |
| **Secondary (one click)** | Investigate a specific answer | Detailed differential, full tool-call results, evidence-extraction trace |
| **Tertiary (separate audit view)** | Forensic + learning loop | Full audit trail, free-form reasoning, prompts / responses, model + skill + tool versions, override history |

Free-form reasoning is intentionally absent from the primary surface; surfacing it by default produces automation bias on coherent-but-wrong rationales (Wornow 2025; Kukhareva 2017).

### Reference layout

Three-pane:

- **Left** — criterion list (compact, scrollable, with status icons and alerts).
- **Middle** — active criterion view (answer, manual section, alternatives, coverage, applied rule, override controls).
- **Right** (largest) — source-note viewer with evidence highlighted in context.

Top bar: approve / override / open audit log. Keyboard shortcuts for review velocity.

### Optional: blinded first pass

A toggle that hides the agent's answer until the reviewer fills it in independently, then reveals for comparison. Off by default. Cheapest mitigation for automation bias; high-value for IRR studies.

## 9. File layout

```
chart-review-platform/
├── tasks/
│   └── lung_cancer_phenotype.md         # reference exemplar
├── lib/                                  # deterministic, shipped
│   ├── parser/                           # .md → compiled_task.json
│   ├── validator/                        # answer vs answer_schema
│   ├── derivation/                       # rule evaluator
│   ├── scheduler/                        # field DAG executor
│   ├── faithfulness/                     # offset-verification utility
│   └── alerts/                           # cross-criterion consistency
├── contracts/
│   ├── compiled_task.schema.json
│   ├── review_record.schema.json
│   ├── evidence.schema.json
│   └── trace.schema.json
├── interfaces/
│   ├── tools/                            # I/O specs only
│   │   ├── omop-query.md
│   │   ├── concept-resolve.md
│   │   ├── note-search.md
│   │   └── note-read.md
│   └── skills/
│       └── skill-template.md             # I/O envelope template
├── adapters/
│   ├── synthetic/                        # generated data + reference tool impls
│   └── omop-duckdb/                      # OMOP CDM CSV adapter scaffold
├── synthetic_data/                        # ~20 patients, OMOP CSVs + notes
└── ui/                                    # built by frontend prompt
```

## 10. Deliverables — two prompts

The brainstorm produces **two prompts**, runnable independently. Both share the contract files (`contracts/`) as their single source of truth.

### Prompt 1 — Backend contract kit (for a coding agent)

Produces: `tasks/`, `lib/`, `contracts/`, `interfaces/`, `adapters/synthetic/`, `synthetic_data/`. The deterministic library is implemented; tools and skills ship as I/O contracts only (markdown specs).

### Prompt 2 — Frontend reviewer UI (for `claude design`)

Produces: `ui/`. Consumes `compiled_task.json` + `ReviewRecord.json` + tool I/O for source-note retrieval. Implements the three-pane layout, all three exposure layers, override capture, and the blinded-first-pass toggle.

## 11. Open questions / known limits

- **Concept-set authoring**: where do task authors get codes? VSAC integration is heavy. For MVP, concept sets are inlined in the task document or referenced from a local `concept_sets/` directory. Athena / UMLS integration is v2.
- **Synthetic data realism**: ~20 patients is enough for UI demo, not for evaluation. A larger synthetic corpus (MIMIC-style) is a follow-up.
- **Override learning loop**: structured overrides are captured but not yet fed back into agent improvement. The capture is the substrate; the loop is v2.
- **Skill discovery**: the contract specifies skill I/O but not how the agent picks skills. That choice is left to the framework / student.
- **Free-form reasoning policy**: the contract permits an agent to emit `reasoning_summary`, but the UI never shows it on the primary surface. Whether to require or forbid emission is an open choice for individual student projects.
