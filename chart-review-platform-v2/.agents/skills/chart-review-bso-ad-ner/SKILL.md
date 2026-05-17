---
name: chart-review-bso-ad-ner
description: >
  BSO-AD (Biological / Social / Other determinants of Alzheimer's Disease)
  NER scope skill. Activates when extracting entities under the BSO-AD
  ontology — 9 entity-type subtrees covering Demographic, Behavior /
  Lifestyle, Economic Stability, Education / Literacy, Food, Health Care,
  Neighborhood, Social and Community Context, and Dementia.

  Use this skill in combination with the universal chart-review-ner
  skill when the task_id is "bso-ad-ner" (or any task with
  task_kind=ner that pins the BSO-AD ontology).
metadata:
  version: 0.1
---

# BSO-AD NER scope skill

Companion to `chart-review-ner` (the universal NER reviewer). This skill
carries the ontology + entity-type guidance for the BSO-AD task. The
universal skill handles the platform workflow (call the right MCP tools
in the right order, faithfulness gating, anchor disambiguation).

The ontology is vendored at `references/ontology/concepts.json` inside
this skill — the NER MCP server resolves it automatically because
`resolveOntologyPath` looks here first (after explicit overrides) before
falling back to the env path.

## Ontology shape

9 entity-type root labels. The agent should only emit `entity_type`
values from this set:

| Root label | Approx. concept count |
|---|---|
| `Demographic` | 35 |
| `Element_Relevant_to_Behavior_and_Lifestyle` | 205 |
| `Element_Relevant_to_Economic_Stability` | 96 |
| `Element_Relevant_to_Education_and_Literacy` | 32 |
| `Element_Relevant_to_Food` | 9 |
| `Element_Relevant_to_Health_Care` | 30 |
| `Element_Relevant_to_Neighborhood` | 61 |
| `Element_Relevant_to_Social_and_Community_Context` | 132 |
| `Dementia` | 60 |

(Use `list_entity_types()` at run time for the authoritative set + counts.)

## Per-entity-type guidance files (REQUIRED PRE-READ)

Before reading any note or calling any MCP tool, you MUST read **every**
YAML file under `references/entity_type_guidance/` in this skill bundle
— there is one per entity_type, 9 files total for BSO-AD:

- `Demographic.yaml`
- `Element_Relevant_to_Behavior_and_Lifestyle.yaml`
- `Element_Relevant_to_Economic_Stability.yaml`
- `Element_Relevant_to_Education_and_Literacy.yaml`
- `Element_Relevant_to_Food.yaml`
- `Element_Relevant_to_Health_Care.yaml`
- `Element_Relevant_to_Neighborhood.yaml`
- `Element_Relevant_to_Social_and_Community_Context.yaml`
- `Dementia.yaml`

Read all 9. Not just the ones you think apply to this chart. The
`negative_examples` and `edge_cases` in the file for a "probably-absent"
entity type are exactly what stops you from emitting a false positive
when the chart turns out to mention it after all. Skipping is a
recall-and-precision failure.

Each YAML has four sections:

- `guidance` — 2–4 sentences on how to tag this entity type
- `exemplars` — verbatim phrases that SHOULD be tagged
- `negative_examples` — phrases that look like the entity but shouldn't
  be tagged, each with a `reason`
- `edge_cases` — specific patterns the methodologist has flagged, each
  with a `pattern` / `correct` / `reason`

The methodologist edits these files in the AUTHOR phase of the Studio UI;
they are the authoritative annotation guidance for the current iter. The
prose below is a high-level summary — always defer to the YAML files
when they disagree.

## Annotation guidance (summary)

- **Demographics**: age, gender, race, ethnicity, country-of-origin,
  marital status. Prefer the most-specific child (e.g. `Female` not
  `Gender`). Numeric ages always need an `anchor` that extends past the
  digits (`anchor="age 67"`, `text="67"`).
- **Behavior / Lifestyle**: smoking, alcohol, physical activity, sleep,
  substance use. These often appear as adjectives or activities; tag the
  noun phrase that names the behavior, not the modifier.
- **Economic Stability**: employment status, income, housing security,
  financial strain. Look for negations ("not employed" still maps to
  `Unemployed`).
- **Education / Literacy**: highest grade, degree, literacy. The
  concept_name should match the *level*, not the institution.
- **Food**: food security, dietary patterns. This subtree is small (9
  concepts) — most clinical notes will yield zero spans here.
- **Health Care**: access, utilization, insurance. Includes both
  "had insurance" and "uninsured" mappings.
- **Neighborhood**: walkability, crime, environmental hazards. Rare in
  notes; usually present only in detailed social histories.
- **Social and Community Context**: social isolation, social support,
  community involvement. The most common Element subtree in clinical
  notes about cognitive concerns.
- **Dementia**: diagnoses, stages, related symptoms. This is the focal
  taxonomy for the corpus.

## Novel candidates

A span the agent recognizes as a clinically meaningful entity but cannot
map to any concept_name in the ontology should be committed with
`status="novel_candidate"` and `concept_name=""`. These are not errors —
they're feedback to the methodologist that the ontology may need a new
concept. The `chart-review-ner-improve` skill (Phase 2) consumes these
to propose ontology extensions.

## Out of scope

This skill is read-only context. All writes flow through the
`chart_review_ner` MCP server. Do not edit `concepts.json` from within
a run — ontology promotion is a methodologist action invoked from the
Studio UI (Phase 2).
