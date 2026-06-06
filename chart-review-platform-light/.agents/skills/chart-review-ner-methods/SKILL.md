---
name: chart-review-ner-methods
description: >
  Drafts an academic-paper Methods section describing an NER chart-review
  study from a locked NER task plus its calibration + cohort QA
  statistics. Use when the user says "write the methods section",
  "draft NER methods", "academic methods text for the ontology
  annotation study", "describe the chart-review NER protocol for the
  paper", or is preparing to publish a study based on a locked NER
  task. Produces past-tense, third-person markdown text (~400-600
  words) with a five-paragraph structure (protocol overview, ontology
  + entity-type definitions, dual-reviewer process + F1 reliability,
  novel-candidate workflow, deployment-stage validation).
metadata:
  version: 0.1
---

# NER methods text skill

Parallel to `chart-review-methods` (phenotype Methods generator).
Differences:

| Phenotype methods | NER methods |
|---|---|
| Cohen's κ headline | macro F1 across entity_types, with tuple κ as secondary |
| Criteria table | Entity-type table with concept counts |
| Inter-rater agreement bucket (Landis–Koch) | F1-adapted bucket (excellent / substantial / moderate / fair / poor) |
| Lock SHA + manual version | Lock SHA + ontology version pin |
| (none) | Novel-candidate workflow paragraph (describing how novel
  spans routed through methodologist review for ontology promotion) |

## Workflow

1. Read the locked task's meta.yaml + scope-skill SKILL.md.
2. Read the calibration report at
   `calibration/<task-id>/<run-id>/raw.json` + `report.md`.
3. Read the cohort QA stats at `cohorts/<task-id>/feedback.json` (when
   available).
4. Read the ontology snapshot pinned by the task's `ontology_pin`.
5. Draft the 5-paragraph Methods text:
   1. **Protocol overview**: what the task is, what entity types it covers, what the source documents are.
   2. **Ontology + entity types**: which ontology version was pinned; named entity-types with brief definitions; concept counts per subtree.
   3. **Reviewer process + reliability**: dual-blind annotation; macro F1 headline; per-entity-type buckets; lowest-F1 entity_types if any.
   4. **Novel-candidate workflow**: what fraction of spans were tagged novel; what methodologist process governed ontology promotion; whether any promotions happened during the study.
   5. **Deployment-stage validation** (optional): cohort drift detection, override rate trending. Skip if the task is pre-deployment.
6. Output the prose as markdown to stdout — the reviewer copy-pastes
   into their manuscript. No platform write — like the phenotype
   version, this is a generation skill, not a state mutation.

## Hard rules

- **Past tense, third person.** "We annotated…", "Two reviewers
  agreed on…". Never "you", "I", "the agent".
- **Macro F1 is the headline.** Tuple κ as secondary. Cite both
  numbers explicitly.
- **Cite the ontology version.** `<ontology-id>@<version>` must
  appear in the Methods text — replication depends on it.
- **Don't fabricate numbers.** If the calibration report is missing,
  refuse the draft and tell the user to run
  `chart-review-ner-calibrate` first.
