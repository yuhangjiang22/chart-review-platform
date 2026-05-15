---
name: chart-review-ner-improve
description: >
  Improves an existing NER task by sampling patient charts, comparing
  agent span lists against human-validated ground truth, clustering
  disagreements by entity_type, and proposing concrete annotation-guidance
  edits. Use when the user says "improve this NER task", "the agent
  keeps mis-labeling <entity_type>", "we keep rejecting <concept> spans",
  "tune the protocol", or after running NER calibration and wanting to
  act on the findings. Writes proposals to
  `proposals/<task-id>/<proposal-id>.yaml`; never modifies the locked
  task directly. Composes with chart-review-ner-calibrate (which surfaces
  F1 failures that become this skill's input) and
  chart-review-ner-ontology-extend (which handles novel_candidate →
  ontology promotion as a separate workflow).
metadata:
  version: 0.1
---

# NER improve skill

You are improving an NER task's annotation guidance by analyzing the
disagreements between agent drafts and reviewer-validated spans, then
proposing concrete edits to the scope-skill's entity-type guidance.

This skill is the NER analogue of `chart-review-improve` (which proposes
phenotype guideline edits). Two key differences:

1. **Target artifact**: this skill writes to
   `proposals/<task-id>/<proposal-id>.yaml` with proposals that target
   `references/entity_type_guidance/*.yaml` files inside the scope
   skill — NOT criterion YAMLs (NER tasks have no criteria).
2. **Out-of-scope**: ontology promotion (turning `novel_candidate`
   spans into new concepts in the ontology) is the
   `chart-review-ner-ontology-extend` skill's job. Versioning concerns
   are different for ontology edits vs annotation-guidance edits.

## Inputs you receive

| Item | Notes |
|---|---|
| `task_id` | The NER task to improve (e.g. `bso-ad-ner`) |
| Disagreements + judge analyses | The output of the calibration + judge phases |
| Reviewer override patterns | Which spans reviewers reject most |
| Optional `focus_entity_type` | Restrict the analysis to one subtree |

## Workflow

1. Read the task's current scope-skill SKILL.md and any existing
   `references/entity_type_guidance/<type>.yaml` files to understand
   current guidance.
2. Read the disagreement summary + judge analyses from
   `pilots/<iter_id>/judge_analyses.json`. Group by `entity_type` and
   `classification_hint`.
3. Cluster by failure mode:
   - **agent_a_error / agent_b_error** patterns → "the agent is
     consistently picking the wrong concept here"
   - **true_ambiguity** patterns → the guidance is underspecified
   - **guideline_gap** patterns → the task doesn't tell the agent how
     to handle this case at all
   - **novel_concept_candidate** patterns → defer to
     `chart-review-ner-ontology-extend` (do NOT propose ontology edits
     from this skill)
4. For each cluster, draft ONE proposal YAML. Each proposal targets
   one entity_type and emits a focused change:
   - **negative_examples** — phrases that look like entities but should
     NOT be tagged ("'social' alone is NOT Social_and_Community_Context
     — require 'social isolation' or 'social support'")
   - **anchor_hints** — context-words that disambiguate short or
     numeric values
   - **edge_case_examples** — patient-case fragments that demonstrate
     the correct call
   - **entity_type_definition_refinement** — a sentence-level edit to
     the scope-skill's prose
5. Write `proposals/<task-id>/<proposal-id>.yaml` using the schema
   below. Never modify the locked scope skill.

## Proposal YAML schema

```yaml
proposal_id: <slug>          # ULID or kebab-case slug
task_id: bso-ad-ner
target_entity_type: Demographic
kind: negative_examples | anchor_hints | edge_case_examples | entity_type_definition_refinement
rationale: |
  Why this edit. Cite the disagreement records (judge_analyses.json
  span_ids) that motivated it.
edit:
  before: |
    (current guidance text, if any)
  after: |
    (proposed guidance text)
evidence:
  - span_id: <hash>
    patient_id: <id>
    note_id: <id>
    quote: "..."
generated_at: <iso>
generated_by: chart-review-ner-improve
status: draft   # methodologist promotes to "accepted" via the UI
```

## Hard rules

- **Read-only on the locked task.** All writes land in `proposals/`.
- **One proposal per entity_type cluster.** Don't bundle multiple
  unrelated edits in one record — methodologists accept proposals
  one at a time.
- **Cite evidence.** Every proposal must reference at least one
  span_id with a clear rationale.
- **Defer ontology changes.** If the right fix is "add a new concept
  to the ontology", emit nothing here and instead direct the user to
  run `chart-review-ner-ontology-extend`.
