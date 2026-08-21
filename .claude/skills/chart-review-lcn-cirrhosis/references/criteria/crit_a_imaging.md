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

## Examples
- "CT: cirrhotic, nodular liver contour; spleen 16 cm (splenomegaly)" (8mo before index) -> `met`
- "US: nodular liver echotexture; recanalized paraumbilical vein" -> `met`
- "MRI: nodular liver; spleen normal size; no varices" -> `not_met` (nodularity alone)
- Qualifying CT but 2 years before index -> `not_met` (out of window)
