---
name: chart-review-cancer-diagnosis
description: >
  Extract cancer histology type, distant-metastasis status, and local-recurrence
  status from a patient's clinical notes; disease extent is computed from the
  latter two. Evidence-cited. Triggers on: cancer type, histology, disease
  extent, metastatic, local recurrence.
---

# Procedure

This is a notes-only, pan-cancer phenotype task. You answer **three leaf fields**
directly:
- `cancer_type` — the histology type (enum).
- `has_distant_metastasis` — `yes` / `no` / `no_info`.
- `has_local_recurrence` — `yes` / `no` / `no_info`.

`disease_extent` is a **computed** field (derived from `has_distant_metastasis`
and `has_local_recurrence`) — **do NOT answer it directly.**

1. `list_notes` to see the chart. Prioritize **pathology / surgical-pathology /
   biopsy / cytology** notes first, then treating-oncologist progress notes,
   then imaging. On a large chart, use **`search_notes`** for high-signal terms
   ("final diagnosis", "carcinoma", "metastatic", "stage IV", "M1",
   "recurrence") to jump to the relevant spans instead of reading everything.
   Use `read_note`/`read_notes` to read the candidates in full.
2. `list_criteria` + `read_criteria(["cancer_type", "has_distant_metastasis",
   "has_local_recurrence"])` to get each field's enum of allowed answers and its
   extraction guidance. **Follow the criterion's mappings and `no_info` rules
   exactly.**
3. For each leaf field, commit one answer via
   `set_field_assessment(field_id, answer, confidence, evidence, rationale)`.
   The `answer` MUST be one of the field's enum values.

   Evidence rules — cite the SMALLEST span that supports the answer:
   - Quote the single sentence/phrase that justifies it (well under ~300 chars).
     Prefer the pathology **"FINAL DIAGNOSIS"** line. Use `find_quote_offsets`
     to get exact offsets so the faithfulness gate passes.
   - Do NOT cite the whole note. A full-document citation is not acceptable.
   - The cited span must be **affirmative** — never cite "no evidence of
     metastatic disease" to support `has_distant_metastasis=yes`; a negation
     supports `no`.
   - For `no` / `no_info`: ALWAYS cite one short span — the section you checked
     where the info would appear if present (Assessment/Plan, Diagnosis, Staging).

## Decision rules (apply to all leaf fields)

- **Source priority:** surgical pathology > biopsy/cytology pathology >
  treating-oncologist note > imaging. Read pathology first.
- **Affirmative only:** extract only what is *affirmatively documented for THIS
  patient*. Never infer or guess. **Exclude negated findings** ("no evidence
  of…", "rule out…") and **family history** ("mother with … cancer").
- **Distant vs regional:** `has_distant_metastasis=yes` requires **distant (M1)**
  spread — a named distant organ or distant nodes, or M1/Stage IV. **Regional
  nodes (N1/N2/N3) are NOT distant** → `no`.
- **Recurrence:** `has_local_recurrence=yes` requires an **explicit** recurrence
  word ("recurrent/relapse/locally recurrent") after prior definitive treatment;
  a positive margin alone is not recurrence.
- **Conflicts:** if notes disagree, take the higher-priority source (and, for
  histology, the **most recent pathology**); record the conflict in `rationale`.
- **Confidence:** `high` = explicit pathology final diagnosis or explicit
  staging (M1/Stage IV); `medium` = oncologist narrative / inferred mapping;
  `low` = imaging-only or ambiguous → prefer `no_info` over a low-confidence guess.

4. **Commit the THREE leaf fields** (`cancer_type`, `has_distant_metastasis`,
   `has_local_recurrence`) via `set_field_assessment` before finishing — every
   leaf must have a value (use `no_info` if absent). **Do NOT commit
   `disease_extent`** — it is derived automatically from the two `has_*` fields.
   **Do NOT call `set_review_status`.** Once the three leaves are committed, emit
   a one-line summary and stop.
