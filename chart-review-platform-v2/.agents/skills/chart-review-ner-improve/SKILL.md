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

The driver (`improveNerTask` in `packages/domain-proposal`) calls you
with a user message that contains:

| Block | What it is |
|---|---|
| Task path + proposals output dir | Where to write proposals |
| Aggregate counts | `entity_type → deleted / added / edited` totals across the cohort — a heatmap of where the agents drift |
| Per-patient diff (JSON) | The substance — see below |

The per-patient diff is **pre-computed** by the driver. You do NOT
need to load runs/ or reviews/ yourself. For each patient:

| Field | Meaning |
|---|---|
| `agent_drafts[]` | Every agent's raw `span_labels` — one entry per agent (e.g. `agent_1`, `agent_2`) |
| `reviewer_spans[]` | The reviewer-validated final `span_labels` from `review_state.json` |
| `validated_notes[]` | Notes the reviewer explicitly marked validated — **only spans inside these notes count as ground truth** |
| `deleted_by_reviewer[]` | Spans an agent emitted but the reviewer removed (false positives) |
| `added_by_reviewer[]` | Spans the reviewer added that no agent proposed (false negatives) |
| `concept_name_edited[]` | Spans where the boundary survived but the reviewer changed `concept_name` (mapping errors) |

## Workflow

1. **Read every `references/entity_type_guidance/<entity_type>.yaml` in
   the scope skill** to understand the current guidance you're
   proposing to edit. Skipping this means your proposals won't know
   what `negative_examples` already exist and you'll duplicate work.

2. **Filter the diff to validated notes only.** A span in an
   unvalidated note carries no ground-truth signal. Discard it before
   clustering.

3. **Cluster by `entity_type` + failure shape.** A cluster qualifies
   to become a proposal when:
   - ≥2 distinct patients show the same disagreement shape on the
     same entity_type, OR
   - 1 patient shows a striking, generalizable disagreement (e.g.
     a concept_name edit that flips the meaning, not just a synonym)

4. **Pick the cheapest fix per cluster:**
   - false-positive cluster (multiple deletes on the same phrase or
     phrase-shape) → `add_negative_example`
   - false-negative cluster (multiple manual adds on the same phrase
     or phrase-shape) → `add_exemplar`
   - concept-name-edit cluster on the same surface form → either
     `add_concept_alias` (when the reviewer's concept exists in the
     ontology) or `edit_guidance` (when the prose is wrong)
   - everything else genuinely novel → `add_edge_case`
   - **Defer to `chart-review-ner-ontology-extend`** when the right
     fix is "add a new concept to the ontology"; emit nothing here
     for that case.

5. **Write one proposal YAML per cluster** at the proposals output
   dir, using the schema below. Never modify files under the task's
   `references/` directory.

## Proposal YAML schema

```yaml
proposal_id: <kebab-case-slug>
task_id: bso-ad-ner
entity_type: Demographic
target_file: chart-review-bso-ad-ner/references/entity_type_guidance/Demographic.yaml
change_kind: add_negative_example | add_exemplar | add_edge_case | edit_guidance | add_concept_alias
rationale: |
  2–4 sentences explaining what disagreement pattern motivated this
  edit and why this is the cheapest fix for it.
evidence:
  patient_ids: [patient_easy_sclc_01, ...]
  span_examples:
    - note_id: 2024-09-30__oncology_progress
      text: "social anxiety"
      agent_concept: Social_Isolation        # what the agent picked (if relevant)
      reviewer_concept: ""                   # what the reviewer changed it to (if relevant)
      reviewer_action: deleted | added | concept_edited
      reason: "psychiatric symptom, not social-context fact"
proposed_patch:
  # A minimal YAML delta to apply to target_file. Use whichever shape
  # matches change_kind:
  add_negative_example:
    phrase: "social anxiety"
    reason: "psychiatric symptom, not Social_and_Community_Context"
  # OR
  add_exemplar: "67M MRN"
  # OR
  add_edge_case:
    pattern: "wife handles all the medications"
    correct: "tag as caregiver-managed-medications (caregiver subtree)"
    reason: "encodes both a caregiver relationship AND a cognition-implying delegation"
  # OR
  edit_guidance:
    before: "(quoted prose from current guidance:)"
    after:  "(replacement prose)"
generated_at: <iso>
generated_by: chart-review-ner-improve
status: draft   # methodologist promotes to "accepted" via the UI
```

## Hard rules

- **Read-only on the task's `references/`.** All writes land in the
  proposals output dir the driver names in your prompt.
- **One proposal per entity_type cluster.** Methodologists accept
  proposals one at a time; don't bundle unrelated edits.
- **Cite evidence.** Every proposal lists at least one concrete
  `span_example` with `note_id` + `text` + `reviewer_action`.
- **Validated notes only.** Spans in non-validated notes are noise.
- **Defer ontology changes.** If the fix is "add a new concept",
  point the user at `chart-review-ner-ontology-extend` and skip
  this cluster.
- **Zero proposals is a valid result.** If every disagreement is a
  one-off (no cluster reaches the threshold), emit a `text` summary
  explaining why and write nothing.
