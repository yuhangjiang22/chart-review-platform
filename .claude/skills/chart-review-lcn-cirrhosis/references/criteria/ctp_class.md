---
field_id: ctp_class
prompt: Current Child-Turcotte-Pugh class at the index date?
answer_schema:
  enum: [A, B, C, not_assessable]
cardinality: one
group: severity
---

# Severity: Child-Turcotte-Pugh class (current)

## Definition
Current **CTP class B or C** at index disqualifies compensation (LCN Cirrhosis
Severity criterion). Class A is compatible with compensated.

## Extraction guidance
**Always commit one value.** Prefer a documented class ("Child-Pugh A/B/C",
"CTP 7 = B"). Compute from components (bilirubin, albumin, INR,
ascites, encephalopathy) only when all are documented near index (say
`computed`). `not_assessable` when the chart lacks the inputs — does NOT
disqualify.

## Examples
- "Child-Pugh class A (5 points)" -> `A`
- "CTP-B cirrhosis" at index -> `B`
- No class documented, components incomplete -> `not_assessable`
