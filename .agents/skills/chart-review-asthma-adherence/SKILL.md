---
name: chart-review-asthma-adherence
description: >
  Asthma adherence task. Activates when extracting structured
  guideline-concordance signals from an asthma patient's chart — tier
  0 (eligibility), tier 1 (control assessment: ACT score, exacerbation
  history, controller use), tier 2 (management: step therapy,
  spirometry follow-up, written action plan).

  Use this skill when task_kind=adherence and the task_id is
  asthma-adherence. The pipeline-extract-adherence package reads the
  references/questions/*.yaml + references/rules/*.yaml in this bundle
  to build the tier prompts and concordance verdicts.
metadata:
  version: 0.1
---

# Asthma adherence scope skill

This skill carries the question framework + rule set for the asthma
adherence task. The platform's `pipeline-extract-adherence` runs three
serialized passes per patient:

1. **Tier 0 — eligibility.** Is the patient an asthma case in the
   lookback window? If not, every later-tier rule resolves to
   `EXCLUDED`.
2. **Tier 1 — assessment.** ACT score, exacerbations, controller-
   medication adherence proxy, spirometry availability.
3. **Tier 2 — management.** Step therapy alignment, written action
   plan, follow-up scheduling.

Each tier answer feeds the next tier's prompt as compact JSON so the
model doesn't re-derive earlier facts. The rule engine
(`@chart-review/rule-engine`) evaluates the YAML rules against the
collected `QuestionAnswer[]` and emits a `RuleVerdict[]` per patient.

## Retrieval order — MANDATORY

**You MUST follow this order on every question.** Skipping straight to
notes when structured data is available is the most common failure mode
of this skill; the verifier post-pass will flag your answer as
`contradicted` and the methodologist will see a red `OMOP ✗` chip
next to your name. This wastes their time and the next iter's training
data.

The order is:

1. **`list_structured_data` ONCE** at the start of the session. Cache
   the table names + row counts mentally. Tables present →
   the corresponding read in step 2 is mandatory.
2. **`read_structured_data(table=...)`** for every question whose
   `retrieval_hints` says "STRUCTURED FIRST". This is most T0, T1, and
   T2 questions. Read the table BEFORE committing the answer. Read
   each table once and reuse the result across all questions that need
   it.
3. **`search_notes(queries=[...])`** when structured data didn't have
   the answer and you know what string to look for. Multi-term keyword
   search returns filename + offset + ±120-char snippet per hit. Cheap,
   fast — use for `"ACT"`, `"action plan"`, `"fluticasone"`,
   `"exacerbation"`, `"declined"`, `"refused"`, etc. Prefer this over
   reading every note when you know what you're looking for.
4. **`list_notes` + `read_notes`** as the LAST fallback. Reading every
   note for every question is expensive and error-prone — only do it
   when steps 1-3 didn't pinpoint the evidence.

### Verifier feedback loop

After every `set_question_answer` call, the response includes
`verifier_status`:

- **`confirmed`** — structured data supports your answer. Move on.
- **`contradicted`** — structured data DISAGREES. The response also
  includes `verifier_note` explaining the disagreement (e.g.
  *"measurements ACT=19 (2026-04-12) ≠ answer 23"*). You MUST either:
  (a) re-read the structured table the note pointed at, find your
  mistake, and call `set_question_answer` again with the corrected
  value; OR (b) if you genuinely believe the structured row is wrong
  (rare), commit the same answer and explain in `reasoning` why the
  structured data is misleading.
- **`no_check`** — no structured check available for this question
  (e.g. T0-AgeOk reads patient meta, T2-StepTherapyMatch is composite).
  No action needed.

A `contradicted` answer left uncorrected is a real bug in your output.
The verifier exists to catch it before the methodologist has to.

### Evidence citations

When you commit an answer from a structured row, cite the table +
row_id in `evidence`:
```
{ note_id: "omop:drugs:9101", quote: "Fluticasone propionate 110 MCG BID" }
```
When you fall back to a note, cite the verbatim quote with note filename.

## Tables to expect

| Table | Used for |
|---|---|
| `conditions` | T0 eligibility — find J45.* codes |
| `drugs` | Controller list, SABA refill cadence, OCS bursts (exacerbations), `is_controller` + `drug_class` + `fills[]` + `refill_pdc_12mo` |
| `measurements` | ACT score (LOINC 75827-3), spirometry (FEV1/FVC, FEV1%, post-bronchodilator) |
| `encounters` | ED visits / hospitalizations driving exacerbation count (filter `type="Emergency"` AND `asthma_related=true`) |
| `observations` | Smoking, severity classification, action-plan status |
| `procedures` | Spirometry procedure date (CPT 94060) |

## Authoring notes

- Question ids are stable strings (`T0-Q1`, `T1-ACT`, …). Renaming an
  id invalidates the audit trail for prior iterations.
- `answer_schema.enum` strings are case-sensitive; the agent is told
  to match them verbatim.
- Rule expressions use the DSL described in
  `packages/rule-engine/src/index.ts` (compare / in / is missing /
  not / and / or, with literal numbers, strings, booleans).
- `nuanced: true` rules trigger an LLM judge after the deterministic
  verdict — use it sparingly (e.g. distinguishing a documented refusal
  from an undocumented gap).

## Files

- `references/questions/T0_eligibility.yaml`
- `references/questions/T1_assessment.yaml`
- `references/questions/T2_management.yaml`
- `references/rules/eligibility.yaml`
- `references/rules/control_concordance.yaml`
- `references/rules/management_concordance.yaml`
- `references/attribution.yaml`
