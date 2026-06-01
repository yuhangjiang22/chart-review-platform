---
name: chart-review-ner-ontology-extend
description: >
  Proposes ontology extensions for an NER task. Reads `novel_candidate`
  spans surfaced by the calibration / cohort phases, clusters them by
  semantic similarity within their entity_type subtree, and proposes
  new concept_names (or new parent_label edges) to extend the ontology.
  Use when the user says "extend the bso-ad ontology", "promote novel
  candidates to concepts", "we keep tagging X as novel but it should be
  a concept", or after running NER cohort drift and finding rising
  novel_candidate rates. Writes proposals to
  `var/ontologies/<ontology-id>/proposals/<proposal-id>.yaml` — a
  separate workflow from chart-review-ner-improve (which proposes
  annotation-guidance edits, not ontology changes).

  Why two skills? Ontologies version independently of any one task —
  the same ontology can be pinned by many tasks. Extending the ontology
  is a different lifecycle from refining a task's annotation guidance.
metadata:
  version: 0.1
---

# NER ontology-extend skill

You are proposing additions to the active ontology based on
`novel_candidate` spans the reviewers consistently accept. The
methodologist reviews + accepts the proposal in the Studio UI;
acceptance bumps `ontology.version` (a separate identity from the
task version) and triggers re-pinning for any task that wants the
new concepts.

## Inputs you receive

| Item | Notes |
|---|---|
| `ontology_id` | Which ontology to extend (e.g. `bso-ad`) |
| Cohort / iter to draw from | Source of `novel_candidate` spans |
| Optional `focus_entity_type` | Restrict to one subtree |

## Workflow

1. Enumerate `novel_candidate` spans across the cohort/iter, grouped by
   `entity_type`.
2. For each entity_type cluster, cluster the spans by surface form
   similarity (case-insensitive substring overlap; greedy clustering).
3. For each cluster with ≥3 supporting reviewer-accepted spans, draft
   ONE ontology extension proposal:
   - **new_concept** — add `<new_label>` under an existing
     `parent_label`
   - **new_subtree_root** — add a new top-level entity_type (rare;
     requires special methodologist privilege)
   - **rename_concept** — concept_name was misnamed; rename it
4. Write the proposal to
   `var/ontologies/<ontology-id>/proposals/<proposal-id>.yaml`:

```yaml
proposal_id: <ulid>
ontology_id: bso-ad
current_version: "0.1"
target_version: "0.2"
kind: new_concept | new_subtree_root | rename_concept
entity_type: Demographic
parent_label: Demographic
new_label: Pronouns
rationale: |
  Twelve reviewer-accepted novel_candidate spans across the cohort
  consistently named pronouns (he/him, she/her, they/them) under
  Demographic with no existing concept. Distinct from Gender and
  Biological_Sex.
supporting_spans:
  - { patient_id: ..., span_id: ..., text: "she/her" }
generated_at: <iso>
generated_by: chart-review-ner-ontology-extend
status: draft
```

## Hard rules

- **Read-only on the locked ontology.** Proposals are drafts on disk
  — only the methodologist's explicit "promote" action mutates
  `var/ontologies/<id>/<version>/concepts.json`.
- **3-span minimum.** Don't propose extensions for one-off novel
  candidates. Three or more reviewer-accepted novel spans across
  different patients is the floor.
- **Don't propose if `chart-review-ner-improve` is the right fix.**
  If the right call is "the agent should have mapped this to existing
  concept X but didn't", that's an annotation-guidance issue (improve
  skill), not an ontology gap. Cite both possibilities in the rationale
  when ambiguous.
- **Versioning is jointly pinned.** When an ontology promotes,
  downstream tasks pinned to the old version remain on the old
  version until a methodologist explicitly re-pins. Don't assume
  task-level repinning happens automatically.
