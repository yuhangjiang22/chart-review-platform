# File templates — chart-review-build (Phase 2 outputs)

Full file templates written during Phase 2 (drafting). Use the `Write`
tool once per file with the full content populated from Phase 1 answers.

**Output base:** `.claude/skills/drafts/chart-review-<task-id>/`

The reviewer's loader (chart-review skill, /api/tasks endpoint) reads
the produced bundle directly from this path. The legacy
`guidelines/drafts/<task-id>/` location is no longer read.

## Bundle layout

```
.claude/skills/drafts/chart-review-<task-id>/
├── SKILL.md                         (skill stub — agent activation)
├── meta.yaml                        (task-level metadata)
└── references/
    ├── criteria/
    │   ├── <field_id_1>.md          (one atomic criterion per file)
    │   ├── <field_id_2>.md
    │   └── ...
    ├── code_sets/                   (optional)
    │   └── <id>.yaml
    ├── keyword_sets/                (optional)
    │   └── <id>.yaml
    └── edge_cases/                  (optional)
        └── <id>.yaml
```

## `SKILL.md`

```markdown
---
name: chart-review-<task-id>
description: Draft phenotype skill (in development).
---

This skill is a draft. Once it's promoted to
.claude/skills/chart-review-<task-id>/, the SKILL.md is regenerated
with full agent activation content.
```

## `meta.yaml`

```yaml
# <task_id> — chart-review guideline (draft)
task_id: <task_id>
task_type: phenotype_validation     # or cohort_classification
review_unit: patient                # or encounter / episode
manual_version: 0.1.0-draft
index_anchor: index_date
output_shape: <outcome-first | evidence-first | timeline | hybrid | narrative>
overview_prose: |
  <2-3 paragraph synthesis of what the chart review answers>
denominator: "<who is in scope>"
index_event: "<the anchor event, e.g. 'MI hospitalization discharge'>"
time_windows:
  - id: <name_kebab>
    anchor: <anchor_id_from_index_anchor>
    start_offset: "<e.g. -24mo or -P24M>"
    end_offset: "<e.g. 0d or P0D>"
    label: "<human description, e.g. '30 days post discharge'>"
final_output: <field_id_for_main_outcome>
```

### Required fields

The following keys are required and validated by `contracts/task-meta.schema.json`:

- `task_type`, `review_unit`, `manual_version`
- `index_anchor`, `time_windows[]` (each with `id`, `anchor`, `start_offset`, `end_offset`)
- `final_output` (must be the field_id of a criterion in `references/criteria/`)
- `overview_prose`

Do NOT emit `final_output_field`, `index_date_definition`, `population`, or
`status` — those are skill-internal names that the loader does not read.

## `references/criteria/<field_id>.md` (one per atomic criterion — REQUIRED FORMAT)

```markdown
---
field_id: <field_id>
prompt: "<one sentence question>"
answer_schema:
  enum: [yes, no, no_info]          # or type: boolean / type: [number, "null"]
cardinality: one
time_window: <id_from_meta.time_windows>   # optional
group: <group_label>                       # optional, free text
is_applicable_when: <DSL expression>       # optional gate
uses:                                      # optional cross-references
  code_sets:
    - <code_set_id>
  edge_cases:
    - <edge_case_id>
  exemplars:
    - <exemplar_id>
---

# Criterion: <field_id>

## Definition

<1-3 sentences defining exactly what answer means what.>

## Extraction guidance

<2-4 sentences on where to look in the chart, which structured fields
or note types matter, and any time-window or applicability nuances.>

## Examples

**Satisfying**
- "<positive example>" → <answer>
- "<another positive example>" → <answer>

**Non-satisfying**
- "<negative example>" → <other answer>
- "<another negative example>" → <other answer>

**Boundary**
- "<ambiguous case>" → <disambiguation rule and final answer>

## Failure modes

- <common authoring or reviewer mistake to watch for>
- <another failure mode>
```

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
derivation_truth_table:
  - label: pathology positive
    inputs:
      lung_cancer_pathology_present: "yes"
      lung_imaging_suspicious: "no"
      lung_cancer_clinical_mention: "no"
    expected: "confirmed"
  - label: imaging + clinical
    inputs:
      lung_cancer_pathology_present: "no"
      lung_imaging_suspicious: "yes"
      lung_cancer_clinical_mention: "yes"
    expected: "probable"
  - label: nothing
    inputs:
      lung_cancer_pathology_present: "no"
      lung_imaging_suspicious: "no"
      lung_cancer_clinical_mention: "no"
    expected: "absent"
---

## Definition

Final phenotype label per the pathology-first hierarchy.
```

### Critical rules for criterion files

1. **Markdown with YAML frontmatter.** The `---` fences are mandatory. The
   reviewer's parser uses the regex `^---\n([\s\S]*?)\n---\n` to extract
   frontmatter; missing fences = silently skipped file.

2. **No `# TODO` placeholders in body prose.** If the skill cannot resolve a
   reference (e.g. exact ICD-10 codes for a less-common condition), it MUST
   emit an explicit `open_questions:` array on the frontmatter rather than
   leaving `# TODO confirm` markers in extraction guidance. Pre-flight
   and the build-skill validator both reject `# TODO` markers.

3. **`field_id` is the unique key.** Filename should match: `field_id.md`.
   Use snake_case (lowercase + underscores). Don't use the legacy `id:`
   key — write `field_id:` in frontmatter.

4. **One atomic field per file.** NEVER write a frontmatter with a
   `fields:` array of nested sub-fields. If the reviewer asked you to
   capture (start_date, end_date, status), that's THREE files:
   `<event>_start_date.md`, `<event>_end_date.md`, `<event>_status.md`,
   each with its own simple `answer_schema`.

5. **`answer_schema` is JSON-Schema-shaped.** Use `enum: [...]` for
   categorical answers, `type: boolean` for yes/no, `type: number` (or
   `type: [number, "null"]` for nullable), `type: string` for free text,
   `type: string` + `format: "date"` for dates. Don't use form-builder
   types like `single_select`, `multi_select`, `date`.

6. **Body sections use `## Heading` exactly as shown.** The reviewer
   parser extracts `## Definition`, `## Extraction guidance`, `## Examples`,
   `## Failure modes` (and optionally `## Satisfying examples`,
   `## Non-satisfying examples`, `## Boundary examples` as alternatives).
   Other heading text is preserved as plain prose but isn't
   semantically extracted.

## `references/code_sets/<id>.yaml` (only when reviewer has supplied codes)

```yaml
id: <id>
description: "<one-sentence description of what this code set captures>"
system: ICD-10-CM     # or LOINC / SNOMED / RxNorm / OMOP-canonical
codes:
  - code: "<code>"
    description: "<text>"
  - code: "<code>"
    description: "<text>"
includes_pattern:     # optional regex/prefix patterns
  - "C34.*"
excludes:             # optional explicit excludes (with reason)
  - code: "Z85.118"
    reason: "Personal history excluded per protocol"
source: reviewer-supplied
```

## `references/keyword_sets/<id>.yaml` (only when reviewer has supplied keywords / synonyms)

```yaml
id: <id>
description: "<what this keyword set is for>"
terms:
  - "<phrase>"
  - "<phrase>"
synonyms:
  "<canonical>":
    - "<synonym>"
    - "<synonym>"
source: reviewer-supplied
```

## `references/edge_cases/<id>.yaml` (one file per edge case)

```yaml
id: <id>
pattern: "<short pattern label, e.g. 'history-only mention'>"
applies_to:
  - <field_id>
failure_mode: "<what tends to go wrong>"
correct_answer_hint: "<what answer this case should produce>"
example_ref: <exemplar_id>            # optional
```

## Why this format

The reviewer's chart-review skill, the /api/tasks server endpoint, and
the calibration / improvement skills all share the same loader
(`loadPhenotypeCriteria` in `app/server/domain/rubric/phenotype-skill.ts`).
That loader walks `<skill-dir>/references/criteria/*.md`, parses
frontmatter, and extracts the markdown body sections.

If you write `criteria/<id>.yaml` (the legacy build path), or pack
multiple fields into one file via `fields[]`, **the reviewer never sees
those criteria** — `field_count` reports 0 and the guideline is unusable
for review even though the meta.yaml looks correct.

The four-axis split (`Satisfying / Non-satisfying / Boundary / Failure modes`)
is the lift-B convention (see
`skills/chart-review/references/atomic-criteria.md`). Failure modes are
first-class authoring information — they prevent the most common
abstraction errors and give `chart-review-improve` clean targets when
proposing edits.
