---
name: chart-review-ner-codify
description: >
  Post-lock codification for an NER task. From the validated cohort,
  extracts per-entity-type exemplar phrases (real positive spans) and
  negative-example phrases (text the agent labeled but the reviewer
  rejected), plus concept-frequency tables. Writes
  `references/concept_aliases/<entity_type>.yaml` and
  `references/anchor_patterns/<entity_type>.yaml` artifacts that the NER
  extractor's prompt can cite to speed up subsequent runs. Use when the
  user says "codify the bso-ad task", "extract anchor patterns from the
  cohort", "speed up the NER agent for next runs", or after locking an
  NER task and wanting to make subsequent agent runs cheaper.
metadata:
  version: 0.1
---

# NER codify skill

Post-lock artifact generator. Reads the validated cohort under
`reviews/<patient>/<task-id>/review_state.json` and emits two
reference artifacts per entity_type that subsequent agent runs can
read:

## `references/concept_aliases/<entity_type>.yaml`

Per concept_name, a list of surface phrases that have been validated
as that concept in this cohort. Lets the agent normalize aggressively
without round-tripping through `normalize_to_ontology`:

```yaml
entity_type: Demographic
concept_aliases:
  Age:
    - "67-year-old"
    - "age 67"
    - "67M"  # known to mean Age (anchored on M = male)
  Male:
    - "M"
    - "male"
    - "67M"  # known to mean Male (when preceded by digits)
```

## `references/anchor_patterns/<entity_type>.yaml`

Per concept_name, a list of validated `(text, anchor)` patterns. The
agent uses these as a hint for which context-words make a short value
unambiguous in this corpus's prose style.

```yaml
entity_type: Demographic
anchor_patterns:
  Age:
    - { text: "67", anchor: "67M" }
    - { text: "67", anchor: "67-year-old" }
  Race:
    - { text: "Caucasian", anchor: "Caucasian" }
```

## Hard rules

- **`status: locked` required.** Codify must NOT run pre-lock — the
  artifacts it emits derive their authority from the validated cohort.
- **Negative examples are equally important.** Phrases the agent
  emitted but reviewers rejected go into a `negative_examples` block
  per entity_type so the agent learns what NOT to tag.
- **Never modify criteria.** The phenotype version of this skill
  updates criterion `uses:` blocks. NER tasks have no criteria —
  these artifacts ARE the codification.
- **Append, don't overwrite hand-authored entries.** If a methodologist
  has hand-curated `concept_aliases/<type>.yaml`, merge into it
  preserving their entries with a `# hand-authored` comment.
