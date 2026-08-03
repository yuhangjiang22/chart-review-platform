---
name: chart-review-t1d
description: >
  T1D diabetes-type confirmation phenotype. From a patient's clinical notes and
  EHR structured data (OMOP conditions/drugs/measurements), extract the evidence
  that decides whether the patient is true/likely type 1 diabetes vs not T1D vs
  uncertain, and identify completed DDS-17 / T1D-DDS / PHQ-9 with scores.
  Evidence-cited; the DiCAYA proportion, Klompas criteria, and classification are
  computed from the extracted leaves. Triggers on: T1D, type 1 diabetes, diabetes
  type confirmation, Klompas, C-peptide, GAD65 autoantibody, DDS-17, T1D-DDS,
  PHQ-9.
---

# Procedure

This is a **structured-data + notes** phenotype task. You extract **evidence
leaves**; the platform **computes** the DiCAYA proportion, the five Klompas
criteria, the Klompas roll-up, and the final classification from your leaves —
you do **NOT** answer those computed fields.

## Two kinds of leaves — two different rules for "absent"

1. **Section-1 confirmation leaves feed the computed rules. ALWAYS commit them,
   even when there is no evidence — use the explicit negative/absent enum value**
   (`no`, `never`, `none`, `not_measured`, `not_tested`, `no_info`). If you leave
   one blank, every Klompas criterion and the classification that depends on it
   collapse to "Pending". The code counts are integers — commit `0` when there
   are no codes.
2. **Section-2 survey SCORES feed no computation. Leave the score unanswered
   (null) when the chart documents no number — never write `0`** (a PHQ-9 of 0 is
   a real, valid score). Commit the survey *status* enum always; commit the
   *score* only when a number is documented.

## Leaf fields YOU commit

**Section 1 — diabetes codes (integers, commit 0 if none):**
`t1d_code_count`, `t2d_code_count`.

**Section 1 — medications / supplies (enum, always commit):** `insulin_use`
(`current`/`historical`/`never`/`no_info`), `glucagon_rx` (`yes`/`no`),
`noninsulin_med` (`none`/`metformin_only`/`other`/`no_info`), `ketone_strip_rx`
(`yes`/`no`).

**Section 1 — labs (enum, always commit):** `autoantibody_result`
(`positive`/`negative`/`borderline`/`not_tested`), `c_peptide_result`
(`low`/`normal`/`high`/`not_measured`).

**Section 1 — provider diagnosis (enum, always commit):** `endo_provider_dx`
(`t1d`/`t2d`/`none`), `nonspecialist_dx` (`t1d`/`t2d`/`none`).

**Section 1 — longitudinal:** `earliest_t1d_date`, `earliest_t2d_date`,
`first_insulin_date`, `first_glp1_date` (ISO `YYYY-MM-DD` or leave blank if
undated); `explicit_t1d_statement` (`yes`/`no_info`), `glp1_indication_documented`
(`yes`/`no_info`), `continued_t1d_treatment` (`yes`/`no_info`),
`longterm_noninsulin_before_insulin` (`yes`/`no`/`no_info`, always commit).

**Section 2 — surveys (status always; score/date only when documented):**
`dds17_status`, `dds17_score`, `dds17_date`; `t1ddds_status`, `t1ddds_score`,
`t1ddds_date`; `phq9_status`, `phq9_score`, `phq9_date`, `phq9_item9`.

## Computed fields — do NOT answer these

`t1d_code_proportion`, `gt50_t1d`, `klompas_1_glucagon`, `klompas_2_noninsulin`,
`klompas_autoantibody`, `klompas_c_peptide`, `klompas_ketone_strip`,
`overall_klompas_rule_met`, `t1d_insulin_preceded_t2d`, and **`t1d_classification`**
(the final proposal) are derived from your leaves and shown on the Computed panel.
To change them, fix a leaf.

## Workflow

1. **Structured first.** `list_structured_data` then `read_structured_data` for
   `conditions` (ICD diabetes codes), `drugs` (insulin, glucagon, metformin/GLP-1/
   SGLT2, ketone-strip supplies), `measurements` (C-peptide, GAD65/IA-2/ZnT8/IAA
   autoantibodies). Count distinct T1D vs T2D coded events; read lab values + units.
2. **Notes next.** `list_notes`; `search_notes` for high-signal terms ("type 1",
   "T1DM", "insulin", "glucagon", "C-peptide", "GAD", "autoantibody", "endocrinology",
   "DDS", "T1D-DDS", "PHQ-9"); `read_note`/`read_notes` on candidates. Use the
   **true event date** — a note that says "diagnosed as a child" is historical; do
   not stamp it with the note date.
3. `list_criteria` + `read_criteria([...])` for each field's allowed values and
   guidance. **Follow each criterion exactly.**
4. Commit every leaf via `set_field_assessment(field_id, answer, confidence,
   evidence, rationale)`. `answer` must match the field's schema (a listed enum
   value, the raw integer count, a documented number for scores, or an ISO date).

## Evidence rules

- **Prefer structured citations.** When the fact comes from an OMOP row, cite
  `source:"omop"` with `table` + `row_id` (and `concept_id`/`value`/`unit`/
  `evidence_date` when helpful) — no note quote needed.
- **Note citations** cite the SMALLEST affirmative span: `source:"note"` with
  `note_id`, `span_offsets`, and the `verbatim_quote`. Use `find_quote_offsets`
  for exact offsets so the faithfulness gate passes. Never cite a negated or
  family-history sentence to support a positive.

## Decision rules

- **Patient + affirmative only.** Exclude family history, planned/ordered items
  ("GAD panel ordered", "start insulin next visit"), and negations.
- **Codes:** count each distinct coded diabetes event; `E10.*`/`250.x1`/`250.x3`
  → T1D, `E11.*`/`250.x0`/`250.x2` → T2D. Do NOT count `E08/E09/E13/O24`,
  gestational, prediabetes, or hyperglycemia toward either.
- **C-peptide:** `low` only after verifying the value is `< 0.8 ng/mL` in the
  documented units; otherwise `normal`/`high`; `not_measured` if absent.
- **Autoantibody:** `positive` only for a definitive positive result; a negative
  does not exclude T1D; ambiguous → `borderline`.
- **Ketone strips:** a patient-specific urine-ketone/acetone **strip prescription**
  → `yes`; a ketone *lab result* is NOT a strip prescription.
- **`longterm_noninsulin_before_insulin`:** `yes` only when the med history clearly
  shows sustained non-insulin diabetes treatment *before* any insulin start.
- **Surveys:** confirm the specific instrument (DDS-17 = 17-item mean 1–6; T1D-DDS
  = 28-item mean 1–6; PHQ-9 = total 0–27). A generic screening code (CPT 96127,
  G0444, 96160/96161) does NOT identify a specific instrument — require the name /
  score / items / a verified local form. `status` ∈ present_with_score /
  present_without_score / mentioned_planned / blank_template / copied_forward /
  not_present / uncertain. Record `phq9_item9` (self-harm) separately when present.
- **Confidence:** `high` = explicit structured row or documented value; `medium` =
  narrative inference within the rules; `low` = ambiguous → prefer the absent value
  over a guess.

## Ground truth is Human-Only

`t1d_classification` is derived as the machine **proposal** by the guideline's
sequential rule (endo dx → no insulin → objective lab → long-term non-insulin →
nonspecialist dx). The **final** ground-truth call is Human-Only: the reviewer
confirms or overrides it during VALIDATE. Your job is to get every leaf right so
the proposal is well-grounded.

Commit every leaf, do NOT set the computed fields, do NOT call `set_review_status`,
then emit a one-line summary and stop.
