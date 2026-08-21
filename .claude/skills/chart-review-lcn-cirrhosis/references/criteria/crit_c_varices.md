---
field_id: crit_c_varices
prompt: Criterion C - varices within 3 years, on endoscopy or imaging?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: step1_criteria
---

# Criterion C: varices (window <=3 years [sic])

## Definition
**Varices seen on endoscopy or imaging** within 3 years before index.
(LCN Table 2, criterion C; the source doc reproduces the paper's "<=3 year"
wording.) The varices merely need to EXIST - bleeding is a Step-2 matter.

## Extraction guidance
**Always commit one value.** EGD reports and cross-sectional imaging both
qualify ("esophageal varices", "gastric varices", "paraesophageal varices").
Cite the report span; state the date/window.

Wording rules (v2 op 3): the report must DESCRIBE varices — a "history of
varices" mention does not qualify. Collaterals are NOT varices (Baveno VII
lists them separately). No size threshold applies.

Distinct-studies rule (v2 op 4): if the ONLY evidence for varices is the SAME
imaging study that satisfied criterion A, say so in the rationale — Step-1
criteria must come from distinct studies, and the reviewer will not count
both from one study.

## Examples
- "EGD: small esophageal varices, no stigmata" (1y before index) -> `met`
- "CT: gastroesophageal varices" -> `met`
- "EGD: no varices" -> `not_met`
