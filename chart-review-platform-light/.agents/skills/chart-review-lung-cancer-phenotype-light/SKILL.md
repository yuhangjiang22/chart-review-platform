---
name: chart-review-lung-cancer-phenotype-light
description: >
  Extract cancer histology type and disease extent from a patient's
  clinical notes. Two categorical fields, evidence-cited. Triggers on:
  cancer type, histology, disease extent, metastatic, local recurrence.
---

# Procedure

This is a notes-only phenotype task with two categorical fields:
`cancer_type` and `disease_extent`.

1. `list_notes`, then `read_notes` to read all of the patient's clinical notes.
2. `list_criteria` + `read_criteria(["cancer_type", "disease_extent"])` to get
   each field's enum of allowed answers and its extraction guidance.
3. For each field, commit one answer via
   `set_field_assessment(field_id, answer, confidence, evidence, rationale)`.
   The `answer` MUST be one of the field's enum values. Quote verbatim note
   text in `evidence` (with the note_id) so the faithfulness gate passes.
4. Apply the source-document priority: surgical pathology > biopsy pathology >
   treating-oncologist note > imaging. Use `no_info` when the notes do not
   document the field.
5. Emit a one-line summary and stop.
