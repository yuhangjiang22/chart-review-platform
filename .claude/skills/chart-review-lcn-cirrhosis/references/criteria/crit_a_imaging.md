---
field_id: crit_a_imaging
prompt: Criterion A - imaging within 1 year - nodular liver WITH splenomegaly or recanalized umbilical vein?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: step1_criteria
---

# Criterion A: imaging (window <=1 year)

## Definition
Imaging (CT / MRI / ultrasound) **within 1 year** before index showing a
**nodular liver** together with **either splenomegaly or a recanalized
umbilical vein**. (LCN Table 2, criterion A.)

## Extraction guidance
**Always commit one value.** BOTH parts are required: nodularity AND
(splenomegaly OR recanalized/patent umbilical vein). Nodular liver alone ->
`not_met`. Splenomegaly alone -> `not_met`. Radiology impressions are the
primary source. Cite the report span; state the imaging date and that it is
within 1 year of index.

Wording rules (v2 ops 2, 13, 14):
- **Nodular**: accept "nodular contour" / "surface nodularity". "Irregular"
  alone does NOT count (indeterminate). "Coarse" or "heterogeneous
  echotexture" does NOT count - it tracks steatosis, not fibrosis.
- **Splenomegaly**: the radiologist's assertion, or a craniocaudal
  measurement above the local threshold (commonly >12-13 cm) where reported.
- **Umbilical vein**: "paraumbilical vein" counts equally (known misnomer).
  Caput medusae is supportive but is NOT the same finding.

## Examples
- "CT: cirrhotic, nodular liver contour; spleen 16 cm (splenomegaly)" (8mo before index) -> `met`
- "US: nodular liver echotexture; recanalized paraumbilical vein" -> `met`
- "MRI: nodular liver; spleen normal size; no varices" -> `not_met` (nodularity alone)
- Qualifying CT but 2 years before index -> `not_met` (out of window)

## Window anchor (v0.4)
The lookback window for THIS met/not_met answer is anchored to the
**reference date** (`demographics.reference_date`; in legacy extracts where it
is absent, the index date). This enum is a calibration snapshot — the dated
evidence for the outcome scan goes in the companion _date field, which is
WINDOWLESS (see that field's guidance).
