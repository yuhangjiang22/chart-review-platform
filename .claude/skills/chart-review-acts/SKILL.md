---
name: chart-review-acts
description: >
  ACTS Alzheimer's/dementia phenotyping — extract from a patient's clinical
  notes: whether impaired cognition (MCI/dementia) is documented
  (impaired_cognition), the APOE genotype as ε2/ε3/ε4 allele presence (apoe2,
  apoe3, apoe4), and postmenopausal status (postmenopause). Evidence-cited.
  Triggers on: impaired cognition, MCI, dementia, APOE genotype, ε2/ε3/ε4,
  postmenopause, ACTS.
---

# Procedure

This is a **notes-only** phenotype task. You answer **five independent leaf
fields** directly, each with one allowed value and an evidence citation:

- `impaired_cognition` — `1` (MCI/dementia/cognitive impairment documented) / `0`.
- `apoe2` / `apoe3` / `apoe4` — `1` (allele present) / `0` (genotype rules it out) /
  `NA` (no/partial genotype documented). If **no APOE genotype is documented at
  all, set all three to `NA`** (never 0/0/0 — that is genotypically impossible).
- `postmenopause` — `1` (postmenopausal/menopause documented) / `0`.

1. `list_notes` to see the chart. Use **`search_notes`** for high-signal terms to
   jump to the relevant spans on a large chart:
   - cognition: "MCI", "dementia", "Alzheimer", "cognitive impairment", "MoCA",
     "MMSE", "neuropsych".
   - APOE: "APOE", "ApoE", "Apolipoprotein E", "ε2/ε3/ε4", "e2/e3/e4", "genotype".
   - menopause: "postmenopausal", "menopause", "LMP".
   Use `read_note`/`read_notes` to read candidates in full.
2. `list_criteria` + `read_criteria([...])` to get each field's allowed values and
   its extraction guidance. **Follow each criterion's mappings and NA/0 rules
   exactly.**
3. For each field, commit one answer via
   `set_field_assessment(field_id, answer, confidence, evidence, rationale)`. The
   `answer` MUST be one of the field's enum values.

   Evidence rules — cite the SMALLEST span that supports the answer:
   - Quote the single justifying sentence/phrase (well under ~300 chars) and use
     `find_quote_offsets` for exact offsets so the faithfulness gate passes.
   - The span must be **affirmative** for a `1` — never cite a negated sentence
     ("no cognitive impairment") to support `impaired_cognition=1`.
   - For `0` / `NA`, cite the short section you checked where the info would
     appear if present (assessment, genetics/labs, GYN history).

## Decision rules (apply to all fields)

- **Patient-only, affirmative:** extract only what is documented for THIS
  patient. **Exclude family history** ("mother had Alzheimer's"), **plans/orders**
  ("memory workup planned", "APOE testing ordered"), and **negations**.
- **Do not infer APOE** from an AD diagnosis, cognitive status, risk, or family
  history — only from a documented genotype / ε4-carrier statement.
- **APOE coupling:** when a full two-allele genotype is documented, set the three
  alleles per the genotype mapping (a fully documented genotype always yields ≥1
  allele = `1`). When none is documented, all three are `NA`.
- **Cognition:** subjective concern alone, transient delirium, or evaluation-only
  → `0`; a confirmed MCI/dementia diagnosis, clinician-corroborated decline, or
  impaired objective testing → `1`.
- **Confidence:** `high` = explicit diagnosis / documented genotype / explicit
  postmenopausal statement; `medium` = narrative inference within the rules;
  `low` = ambiguous → prefer `0`/`NA` over a low-confidence guess.

4. **Commit all five fields** via `set_field_assessment` before finishing — every
   field must have a value. **Do NOT call `set_review_status`.** Once the five are
   committed, emit a one-line summary and stop.
