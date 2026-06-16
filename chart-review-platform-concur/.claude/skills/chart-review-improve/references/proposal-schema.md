# Proposal YAML schema — chart-review-improve

Full schema for a proposal file at
`proposals/<guideline-id>/<proposal-id>.yaml`.

One cluster = one proposal file. Don't bundle unrelated edits into a single
file.

## Full schema

```yaml
id: prop-<short-uuid>
guideline_id: <guideline-id>
created_at: <ISO timestamp>
created_by: chart-review-improve skill
target_field: <criterion id, OR "operational/<type>/<id>" for cross-criterion>
change_kind: >
  One of: edge_case_add | keyword_set_add | code_set_add |
  guidance_prose_revise | gate_revise | derivation_revise | exemplar_add |
  code_set_revise | keyword_set_revise
motivating_patients: [<patient_ids that drove this proposal>]
evidence:
  - patient: <pid>
    agent_answer: <answer the agent gave>
    reviewer_answer: <answer the reviewer gave>
    edit_reason: <reason code — see clustering-heuristics.md>
    reviewer_evidence: <verbatim quote or OMOP row the reviewer used>
proposal:
  # The concrete edit, in the same shape as the target artifact.
  # See per-change_kind examples below.
rationale: <2-3 sentences on why this edit fixes the cluster>
provenance:
  source: override_pattern   # or "calibration_disagreement" or "cohort_feedback"
  status: draft              # draft | accepted | rejected
```

## Per-`change_kind` proposal shapes

### `edge_case_add`

```yaml
proposal:
  edge_case:
    id: <new_edge_case_id>
    pattern: |
      <Description of the clinical scenario that is the trap.>
    applies_to: [<criterion_ids>]
    failure_mode: <what the agent typically does wrong in this scenario>
    correct_answer_hint: <what answer/action this case should produce>
```

### `keyword_set_add`

```yaml
proposal:
  keyword_set:
    id: <id>
    description: <one sentence on what concept these terms signal>
    terms: [<term1>, <term2>, ...]
    source: override_pattern
```

### `code_set_add` / `code_set_revise`

```yaml
proposal:
  code_set:
    id: <id>
    # For adds:
    codes:
      - code: <code>
        description: <short label>
    # For revises (adding to excludes):
    field: excludes
    add:
      - code: <code>
        reason: <why this code should be excluded>
```

### `guidance_prose_revise`

```yaml
proposal:
  guidance_prose:
    field: <"definition" or "examples">
    replacement: |
      <New text for the field. For "examples", include full bullet list.>
```

### `gate_revise`

```yaml
proposal:
  gate:
    criterion_id: <criterion_id>
    old_expression: <current is_applicable_when value>
    new_expression: <proposed new is_applicable_when value>
    reason: <one sentence on why this gate change fixes the misfires>
```

### `derivation_revise`

```yaml
proposal:
  derivation:
    criterion_id: <criterion_id>
    old_expression: <current derivation value>
    new_expression: <proposed new derivation value>
    reason: <one sentence on why this fixes the disagreements>
```

### `exemplar_add`

```yaml
proposal:
  exemplar:
    id: <exemplar_id>
    patient_id: <patient_id used as the exemplar>
    criteria_demonstrated: [<criterion_ids>]
    narrative: |
      <2-4 sentence walkthrough of the case and what answer it demonstrates.>
```
