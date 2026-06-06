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
   The `answer` MUST be one of the field's enum values.

   Evidence rules — cite the SMALLEST span that supports the answer:
   - Quote the single sentence or phrase that justifies the answer (roughly
     one or two sentences, well under ~300 characters). Use `find_quote_offsets`
     to get exact offsets so the faithfulness gate passes.
   - Do NOT cite the whole note. A citation that spans the entire document is
     not acceptable evidence.
   - For `no_info`: ALWAYS cite at least one short span — the section you
     checked where this information would appear if present (e.g. the
     Assessment/Plan, Diagnosis, or relevant History line). This shows where
     you looked. Do not leave `evidence` empty, and do not paste the full note.
4. Apply the source-document priority: surgical pathology > biopsy pathology >
   treating-oncologist note > imaging. Use `no_info` when the notes do not
   document the field.
5. Emit a one-line summary and stop.
