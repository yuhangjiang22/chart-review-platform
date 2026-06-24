---
name: chart-review-acts
description: >
  ACTS Alzheimer's/dementia phenotyping — extract from a patient's clinical
  notes: impaired cognition (impaired_cognition), the documented APOE genotype
  (apoe_genotype → ε2/ε3/ε4 allele flags computed), postmenopausal status +
  last menstrual period, documented cognitive / depression / neuropsychiatric
  scale scores (MoCA, MMSE, CDR, Hachinski, Mattis DRS, TICS, GDS, Cornell,
  NPI, Global Deterioration stage), education years, and smoking status.
  Evidence-cited. Triggers on: impaired cognition, MCI, dementia, APOE,
  ε2/ε3/ε4, postmenopause, LMP, MoCA, MMSE, CDR, Hachinski, NPI, GDS, smoking,
  ACTS.
---

# Procedure

This is a **notes-only** phenotype task. You extract each **leaf** field that the
chart documents, with an evidence citation. Some fields are **computed** and you
must NOT set them: the APOE allele flags (`apoe2`/`apoe3`/`apoe4`) derive from
`apoe_genotype`, and the severity bands (`moca_severity`, `mmse_severity`,
`cdr_severity`) derive from their scores.

**Leaf fields you extract (only when the note documents them):**

- **Cognition / status:** `impaired_cognition` (`1`/`0`).
- **APOE:** `apoe_genotype` — full genotype (`e2/e2`,`e2/e3`,`e2/e4`,`e3/e3`,
  `e3/e4`,`e4/e4`), single-allele carrier (`e2_carrier`/`e3_carrier`/`e4_carrier`),
  or `none`. (`apoe2`/`apoe3`/`apoe4` auto-derive.)
- **Reproductive:** `postmenopause` (`1`/`0`), `lmp_date` (free-text date/expr).
- **Cognitive scale SCORES (numeric, raw integer as documented):** `moca_score`
  (0–30), `mmse_score` (0–30), `mattis_drs` (0–144), `tics_score` (0–41),
  `hachinski_score` (0–18).
- **Staging (enum):** `cdr_global` (`0`/`0.5`/`1`/`2`/`3`), `gds_stage` (`1`–`7`,
  the Reisberg Global Deterioration Scale).
- **Depression / neuropsych SCORES (numeric):** `gds_depression_score` (Geriatric
  Depression Scale, 0–30), `cornell_csdd` (0–38), `npi_total` (0–144).
- **Demographics:** `education_years` (integer), `smoking_status`
  (`current`/`former`/`never`/`unknown`).
- **Allergy / vaccine (free-text, one value listing all; `none` if absent):**
  `allergen` (substance(s) the patient reacts to), `vaccine_name` (vaccines
  administered/received), `vaccine_category` (each vaccine's category — Live /
  Non-Live / BCG / Active Amyloid or Tau Immunization — assigned via the
  `references/CDC_Vaccine_Reference_Table.md` + `Active_Amyloid_Tau_Immunization_Reference_Table.md`).

1. `list_notes`; use **`search_notes`** for high-signal terms (MCI, dementia,
   Alzheimer, APOE, ε4, MoCA, MMSE, CDR, Hachinski, NPI, GDS, Cornell, DRS,
   TICS, postmenopausal, LMP, smoking, pack, education). `read_note`/`read_notes`
   to read candidates in full.
2. `list_criteria` + `read_criteria([...])` for each field's schema + guidance.
   **Follow each criterion's rules exactly.**
3. For each DOCUMENTED field, commit one answer via
   `set_field_assessment(field_id, answer, confidence, evidence, rationale)`. The
   `answer` must match the field's type: a listed value for enum fields, the
   **raw numeric score** (a number) for numeric fields, or the free-text value
   (LMP). **Leave a field unanswered if the note does not document it** — do not
   guess a score.

   Evidence rules — cite the SMALLEST affirmative span (e.g. "MoCA 21/30",
   "APOE ε3/ε4", "Postmenopausal"). Use `find_quote_offsets` for exact offsets.
   Never cite a negated sentence to support a positive.

## Decision rules

- **Patient-only, affirmative:** extract only what is documented for THIS
  patient. Exclude family history, plans/orders ("memory workup planned", "APOE
  testing ordered"), and negations.
- **Numeric scores:** record the raw documented number only (e.g. "MoCA 21/30" →
  `21`). Do NOT infer a score from a severity word, and do NOT compute the
  severity bands — those derive automatically. Omit a scale entirely if the note
  gives no number for it.
- **APOE = one extraction:** read the documented genotype into `apoe_genotype`
  (full, `*_carrier`, or `none`); never set the allele flags by hand. "homozygous
  ε4" = `e4/e4`; "ε4 carrier" = `e4_carrier`. Do not infer APOE from an AD
  diagnosis, cognitive status, risk, or family history.
- **Cognition:** subjective concern alone, transient delirium, or evaluation-only
  → `0`; confirmed MCI/dementia, clinician-corroborated decline, or impaired
  objective testing → `1`.
- **LMP:** extract the date/time EXPRESSION only; an age of menopause is NOT an
  LMP. **Smoking:** "denies tobacco" → `never`, "quit 2015" → `former`, "1 ppd" →
  `current`.
- **Allergen:** the SUBSTANCE only (not the reaction); include resolved/inactive;
  exclude NKDA (→ `none`), family history, refuted/entered-in-error, suspected,
  panel orders, bare reaction words. **Vaccine:** only administered/received/
  completed (exclude planned/declined/contraindicated/discussed). **Vaccine
  category:** assign from the reference tables (brand→abbreviation→disease, brand
  wins; `Ambiguous` for disease-only mixed-category; passive mAbs = `Not a
  vaccine`) — do not guess from memory.
- **Confidence:** `high` = explicit documented value; `medium` = narrative
  inference within the rules; `low` = ambiguous → prefer omitting over guessing.

4. Commit every documented leaf field via `set_field_assessment`; leave
   undocumented fields unanswered. Do NOT set the **computed** fields (`apoe2`,
   `apoe3`, `apoe4`, `moca_severity`, `mmse_severity`, `cdr_severity`). **Do NOT
   call `set_review_status`.** Emit a one-line summary and stop.
