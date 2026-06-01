---
name: chart-review-ad-cde-ner
description: >
  AD-CDE (Alzheimer's Disease Common Data Elements) NER scope skill.
  Activates when extracting entities under the AD-CDE ontology — 7
  entity-type subtrees: Disease (70), Procedure (69), Medication (56),
  Diagnostic_Test (44), Rating_Criteria (16), Social_Determinant_Of_Health
  (16), Fertility (13). Total 284 concepts.

  Use this skill in combination with the universal chart-review-ner
  skill when task_id is "ad-cde-ner" (or any task with
  task_kind=ner that pins ontology ad-cde@0.1).
metadata:
  version: 0.1
---

# AD-CDE NER scope skill

Companion to `chart-review-ner` (the universal NER reviewer). The
universal skill handles the platform workflow — calling the NER MCP
tools in the right order, faithfulness gating, anchor disambiguation.
This skill carries the ontology + entity-type guidance for the AD-CDE
task.

The ontology is vendored at `references/ontology/concepts.json` inside
this skill and was generated from `AD-ontology/AD_CDE_w_constraint.owl`
by `scripts/convert-ad-cde-to-concepts.mjs`.

## Entity type roots (7)

| Root label | Concept count | Examples |
|---|---|---|
| `Disease` | 70 | Hypertension, Diabetes_Mellitus, Alzheimer_Disease |
| `Procedure` | 69 | Appendectomy, Bariatric_Surgery, Cardiac_Surgery_Procedures |
| `Medication` | 56 | Antihypertensive_Agents, Anticholinergic_Agents, Benzodiazepines |
| `Diagnostic_Test` | 44 | 12_lead_EKG_panel, Glomerular_Filtration_Rate |
| `Rating_Criteria` | 16 | MMSE, CDR, ADAS-Cog (scale-criteria concepts) |
| `Social_Determinant_Of_Health` | 16 | overlaps with BSO-AD SDoH subtree |
| `Fertility` | 13 | menopausal status, pregnancy history |

## What was dropped from the OWL

The OWL contained three roots not retained in this skill:

- `Constraint_Information` (21 concepts) — observation-time and unit
  constraints. These describe how to validate a value, not entities
  to extract from prose.
- `Study_Variable` (2 concepts) — study metadata; too sparse.
- 3 singleton orphans (`Benzodiazepines`, `Creatinine_Blood_Test`,
  `Cognitive_Function_Clinical_Assessment`) — already covered as
  descendants of `Medication` / `Diagnostic_Test` / `Rating_Criteria`.

The converter script (`scripts/convert-ad-cde-to-concepts.mjs`)
documents the kept-root set.

## When to use

When the task_id is `ad-cde-ner` and the user wants entity extraction
against AD-CDE concepts. Don't activate alongside `chart-review-bso-ad-ner`
unless the methodologist explicitly composes both ontologies in the
same task (separate ontology_pin lines).
