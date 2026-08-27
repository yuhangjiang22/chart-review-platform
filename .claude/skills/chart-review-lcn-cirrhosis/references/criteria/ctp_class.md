---
field_id: ctp_class
prompt: Current Child-Turcotte-Pugh class at the reference date?
answer_schema:
  enum: [A, B, C, not_assessable]
cardinality: one
group: severity
---

# Severity: Child-Turcotte-Pugh class (current)

## Definition
Current **CTP class B or C** disqualifies compensation (LCN Cirrhosis
Severity criterion). Class A is compatible with compensated. "Current" means
at the REFERENCE date (the end of the chart) — a calibration snapshot; the
outcome scanner separately computes a lab-based CTP floor at every candidate
date.

## Extraction guidance
**Always commit one value.** Prefer a documented class ("Child-Pugh A/B/C",
"CTP 7 = B").

**MANDATORY COMPUTATION:** when the three lab components (bilirubin, albumin,
INR) are charted on/near a single day near reference, you MUST score them
(bilirubin <2/2-3/>3 -> 1/2/3; albumin >3.5/2.8-3.5/<2.8 -> 1/2/3; INR
<1.7/1.7-2.3/>2.3 -> 1/2/3) and add the ascites and encephalopathy components
from the documented picture (absent -> 1 each; present-mild -> 2; tense/
refractory ascites or grade III-IV HE -> 3). 5-6 -> `A`, 7-9 -> `B`,
10-15 -> `C`, and say `computed`. `not_assessable` with the lab components
present is a wrong answer (a confirmed pilot false positive — labs alone
scored 5 points and a CT showed ascites, i.e. at least class B — passed
through as `not_assessable`).

`not_assessable` only when the chart genuinely lacks the inputs — does NOT
disqualify.

## Examples
- "Child-Pugh class A (5 points)" -> `A`
- "CTP-B cirrhosis" at reference -> `B`
- Bili 2.2 (2) + albumin 3.5 (2) + INR 1.22 (1) + CT ascites (2) + no HE (1) = 8 -> `B` (computed)
- No class documented, no bilirubin/albumin/INR anywhere near reference -> `not_assessable`
