---
field_id: crit_d_biomarker
prompt: Criterion D - blood biomarker within 6 months - FIB-4 >2.67 or platelet count <150?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: step1_criteria
---

# Criterion D: blood-based biomarker (window <=6 months)

## Definition
Within 6 months before index: **FIB-4 >2.67** or **platelet count <150**
(the source doc reproduces the paper's "<150/mL" [sic]; operationally
<150 x10^9/L). (LCN Table 2, criterion D.)

## Extraction guidance
**Always commit one value.** MANDATORY ORDER: FIRST call
read_structured_data(table="measurements") and look for a PLATELET COUNT in
the 6-month window — a platelet value <150 ALONE satisfies this criterion — check the MINIMUM value across ALL platelet rows in the window, never a single draw;
the absence of a documented FIB-4/APRI is IRRELEVANT when platelets qualify.
Do NOT answer `not_met` on "no FIB-4 documented" without having checked the
platelet rows. Platelets: cite the structured row (table+row_id). FIB-4: use
a documented value; otherwise compute (age x AST) / (platelets x sqrt(ALT))
ONLY when all inputs are within the window - say `computed` in the rationale
and cite the input rows. Either branch (FIB-4 OR platelets) suffices.

## Examples
- Platelets 112 (2mo before index) -> `met`
- "FIB-4 = 3.4" in a hepatology note (in window) -> `met`
- Platelets 210 and FIB-4 1.9 -> `not_met`
- Platelets 130 but 9 months before index -> `not_met` (out of window)

## Window anchor (v0.4)
The lookback window for THIS met/not_met answer is anchored to the
**reference date** (`demographics.reference_date`; in legacy extracts where it
is absent, the index date). This enum is a calibration snapshot — the dated
evidence for the outcome scan goes in the companion _date field, which is
WINDOWLESS (see that field's guidance).
