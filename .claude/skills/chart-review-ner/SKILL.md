---
name: chart-review-ner
description: >
  Universal NER (named-entity recognition) reviewer for chart-review-platform-v2.
  Activates when an NER task asks the agent to extract entity spans from a
  patient's notes and normalize each span to a concept_name from the task's
  ontology. Composes with a per-task scope skill (chart-review-<task-id>)
  that supplies the ontology and any task-specific guidance. Calls the
  chart_review_ner MCP server's 7 tools — list_entity_types,
  get_concept_tree, normalize_to_ontology, locate_in_source,
  set_span_label, set_span_status, get_span_review_state.

  Use this skill whenever the user asks to "run NER on this patient",
  "extract entities from these notes", "label this chart against the
  <name> ontology", or activates a task with task_kind=ner.
metadata:
  version: 0.1
---

# Chart-review NER skill

You are extracting entity spans from a patient's notes and normalizing each
to a canonical concept_name in the active task's ontology. You write through
the `chart_review_ner` MCP server — do not write files directly.

This is the platform analogue of the bso-ad skill (the upstream NER reference
at `claude-agent-sdk-benchmark/.claude/skills/bso-ad/`), adapted for the
chart-review-platform's multi-note patient corpus and faithfulness gating.

---

## Inputs

A run is invoked with:

| Parameter | Example | Notes |
|---|---|---|
| `subject` | `patient_fake_cancer_14` | A patient under `corpus/patients/` |
| `task_id` | `bso-ad-ner` | An NER task at `.agents/skills/chart-review-<task_id>/` |

The patient's notes are in your `cwd` as `<note_id>.txt` files (e.g.
`2024-08-22__ct_chest.txt`). You enumerate them; each is a separate
source-of-truth for span offsets.

---

## Reading the scope skill

Read the scope skill's `SKILL.md` at
`.agents/skills/chart-review-<task_id>/SKILL.md` for the summary of
entity types in scope. Open individual entity-type guidance YAMLs
at `references/entity_type_guidance/<entity_type>.yaml` lazily — only
for the entity types you're actually emitting or considering — to
keep the context small. The scope SKILL.md's summary section is
usually enough for read-only reasoning.

---

## Data access — ontology via MCP

Tools on the `chart_review_ner` server. Always call `list_entity_types`
FIRST so you only emit entity_type values the ontology defines.

| Tool | Purpose |
|---|---|
| `list_entity_types()` | Return supported entity types (root labels of the task's ontology subtrees). |
| `get_concept_tree(entity_type)` | ASCII tree of all concept_names under that entity_type. Pick the most specific concept that fits the span. |
| `normalize_to_ontology(entity_type, label)` | Map a surface form to a canonical concept_name. Precedence: exact → case-insensitive → underscore-normalized → substring candidates. found=false with `alternatives` means "pick one explicitly" or tag novel_candidate. |
| `locate_in_source(note_id, anchor, text)` | Resolve authoritative `(start, end)` for `text` inside `note_id`, located via `anchor`. **DO NOT compute offsets yourself.** |
| `set_span_label(...)` | Commit one span. Faithfulness-gated: `source[start:end] === text` must hold or the call is rejected. |
| `set_span_status(span_id, status)` | Update an already-committed span (e.g. reject, promote novel_candidate to mapped). |
| `get_span_review_state()` | Read the current span list — useful to detect duplicates before re-emitting. |

---

## Mapping rules

- Always annotate at the **most specific** level. Use parent labels only
  when the text cannot be mapped to a child.
- `normalize_to_ontology(entity_type, span_text)`:
  - `found=true` → use the returned `concept_name`, status="mapped".
  - `found=false` with `alternatives` → either re-normalize with a chosen
    alternative if you are confident, or status="novel_candidate",
    concept_name="".
  - `found=false`, no alternatives → status="novel_candidate", concept_name="".
- A span whose entity_type isn't in `list_entity_types()`'s set should not
  be emitted at all — choose a different entity_type or skip.

---

## Anchoring rules — `text` vs `anchor`

`text` is the entity value to store. `anchor` is the substring used to
locate `text` in the note. For unambiguous long entities, `anchor == text`.
For short / numeric / ambiguous values, extend `anchor` with surrounding
context to make it unique.

Examples:

| Source                                  | Bad                                    | Good                                       |
|---|---|---|
| `"birth date 1958/03/02, age 58"`       | `text="58"`, `anchor="58"` (ambiguous) | `text="58"`, `anchor="age 58"` |
| `"... Alzheimer's disease ..."` (once)  | (anchor==text is fine)                  | `text="Alzheimer's disease"`, `anchor=` same |
| `"type 1 diabetes ... type 2 diabetes"` | `text="diabetes"`, `anchor="diabetes"`  | `text="diabetes"`, `anchor="type 2 diabetes"` |

After picking `text` and `anchor`, **always** call
`locate_in_source(note_id, anchor, text)`. Failures:

- `found=false`, `anchor_match_count > 1` → anchor ambiguous; extend with
  more context.
- `found=false`, `anchor_match_count == 0` → anchor not verbatim in source;
  fix spelling / whitespace.
- `found=false`, text-not-in-anchor → `text` isn't actually a substring of
  `anchor`; you contradicted yourself, fix and retry.

---

## Writing — the commit contract

For each span, after `locate_in_source` returns `found=true`, call
`set_span_label` with the returned `(start, end)`. The platform validates
`source[start:end] === text` against the note bytes; a mismatch returns
`error_code: "faithfulness_violation"` and the span is rejected. The
platform also computes a `span_id` (stable hash of
`note_id|start|end|entity_type`) so duplicate spans collapse into one
record on disk.

Your turn is complete when every candidate span across every note has
been committed via `set_span_label`. Emit a brief summary line and stop.
Do NOT ask clarifying questions in batch mode.

---

## Composition with the task scope skill

If a skill named `chart-review-<task_id>` exists (e.g.
`chart-review-bso-ad-ner`), it provides:
- The ontology context (which `concepts.json` is active)
- Annotation guidance specific to that task (which entity types to focus
  on, edge cases, exemplars)

Activate it alongside this universal skill. This universal skill carries
the workflow + tool contract; the scope skill carries the domain.
