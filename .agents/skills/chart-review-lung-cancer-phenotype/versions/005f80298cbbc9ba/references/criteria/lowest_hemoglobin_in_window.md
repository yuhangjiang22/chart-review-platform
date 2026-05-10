---
field_id: lowest_hemoglobin_in_window
schema_hash: 7c2cda21adcd6358
prompt: Lowest documented hemoglobin in the lookback window (g/dL). Null if no hemoglobin
  measurement is found.
answer_schema:
  type:
  - number
  - 'null'
cardinality: one
time_window: lookback_24mo
group: labs
uses:
  keyword_sets:
  - kw_lowest_hemoglobin_in_window
  code_sets:
  - codes_lowest_hemoglobin_in_window
---

# Criterion: lowest_hemoglobin_in_window

## Definition

A lab-value extraction field. Hemoglobin is reported in grams per deciliter (g/dL). Values reported in g/L are divided by 10. Cancer-related anemia of chronic disease commonly produces values below 12 g/dL in untreated lung-cancer patients; this field feeds the derived `pre_treatment_anemia_present` flag.

## Extraction guidance

Search OMOP measurements (LOINC 718-7 / concept name 'Hemoglobin' or 'Hgb') and note text (Hgb, Hb, hemoglobin) within the lookback window. Report the single lowest value. If multiple units appear, normalize to g/dL (a g/L value divided by 10). If no hemoglobin is found, return null with missingness_reason='not_documented'.

## Examples

- OMOP measurement row "Hemoglobin 11.4 g/dL on 2025-02-14" → `11.4`
- Discharge summary line "Pre-op Hgb 11.6, transfusion not required" → `11.6`
- No hemoglobin documented anywhere in the window → `null` with `missingness_reason: not_documented`

