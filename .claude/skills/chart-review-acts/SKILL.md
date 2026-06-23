---
name: chart-review-acts
description: >
  ACTS Alzheimer's/dementia phenotyping — extract from a patient's clinical
  notes: whether impaired cognition (MCI/dementia) is documented
  (impaired_cognition), the documented APOE genotype (apoe_genotype, from which
  ε2/ε3/ε4 allele presence apoe2/apoe3/apoe4 is computed), and postmenopausal
  status (postmenopause). Evidence-cited.
  Triggers on: impaired cognition, MCI, dementia, APOE genotype, ε2/ε3/ε4,
  postmenopause, ACTS.
---

# Procedure

This is a **notes-only** phenotype task. You extract **three leaf fields**
directly, each with one allowed value and an evidence citation. The three APOE
allele flags (`apoe2`/`apoe3`/`apoe4`) are **computed** from the genotype — do
NOT set them.

- `impaired_cognition` — `1` (MCI/dementia/cognitive impairment documented) / `0`.
- `apoe_genotype` — the documented APOE genotype: a full genotype (`e2/e2`,
  `e2/e3`, `e2/e4`, `e3/e3`, `e3/e4`, `e4/e4`), a single-allele carrier
  (`e2_carrier` / `e3_carrier` / `e4_carrier`), or `none` when no genotype is
  documented. `apoe2`/`apoe3`/`apoe4` derive automatically from this value.
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
- **APOE = one extraction:** read the documented genotype into `apoe_genotype`
  (a full genotype, a single-allele `*_carrier`, or `none`). The three allele
  flags derive from it automatically — never set them by hand. A single-allele
  carrier statement ("ε4 carrier") → `e4_carrier`; "homozygous ε4" is the full
  genotype `e4/e4`.
- **Cognition:** subjective concern alone, transient delirium, or evaluation-only
  → `0`; a confirmed MCI/dementia diagnosis, clinician-corroborated decline, or
  impaired objective testing → `1`.
- **Confidence:** `high` = explicit diagnosis / documented genotype / explicit
  postmenopausal statement; `medium` = narrative inference within the rules;
  `low` = ambiguous → prefer `0`/`NA` over a low-confidence guess.

4. **Commit the three leaf fields** (`impaired_cognition`, `apoe_genotype`,
   `postmenopause`) via `set_field_assessment` before finishing — do NOT set the
   derived `apoe2`/`apoe3`/`apoe4` (they auto-compute from `apoe_genotype`).
   **Do NOT call `set_review_status`.** Once the three leaves are committed, emit
   a one-line summary and stop.
