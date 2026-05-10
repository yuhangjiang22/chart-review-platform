---
field_id: time_to_onset
prompt: "What is the time interval between MS-DMT initiation (or cessation) and liver injury onset?"
answer_schema:
  type: number
cardinality: one
group: "RUCAM Scoring"
---

# Criterion: Time to Onset

## Definition

This criterion assesses the temporal relationship between the suspect MS-DMT exposure (start or stop) and the appearance of liver injury. Shorter, more predictable intervals (5–90 days from initiation; ≤15–30 days post-cessation) strongly suggest causality. Onset before drug initiation or >15–30 days after stopping (depending on hepatocellular vs. cholestatic pattern) excludes causality by RUCAM rules.

## Extraction guidance

Identify three key dates from the chart: (1) date the MS-DMT was started, (2) date the MS-DMT was stopped (if applicable), and (3) date of first abnormal liver enzyme. Determine the injury pattern (hepatocellular if R > 5.0, cholestatic if R < 2.0, mixed if R = 2.0–5.0) by calculating R = [ALT/ULN] ÷ [Alk P/ULN]. Apply time-window rules specific to hepatocellular vs. cholestatic injury and whether this is the patient's initial or subsequent exposure to the drug. For multiple DMT switches, score the DMT active at injury onset.

## Examples

**Hepatocellular, initial treatment, onset 5–90 days from start → Score +2**
- DMT started Jan 1, abnormal ALT first detected Mar 15 (73 days after start), R = 8 (hepatocellular)

**Hepatocellular, initial treatment, onset <5 or >90 days → Score +1**
- DMT started Jan 1, abnormal ALT detected Jan 2 (1 day), R = 7 (hepatocellular)
- DMT started Jan 1, abnormal ALT detected May 1 (120 days), R = 9 (hepatocellular)

**Hepatocellular, post-cessation ≤15 days → Score +1**
- DMT stopped Mar 1, abnormal ALT first detected Mar 10 (9 days post-stop), R = 6 (hepatocellular)

**Hepatocellular, post-cessation >15 days → Score -2 (Excluded)**
- DMT stopped Mar 1, abnormal ALT first detected Apr 1 (31 days post-stop), R = 7 (hepatocellular)

**Cholestatic, initial treatment, onset 5–90 days → Score +2**
- DMT started Feb 1, bilirubin elevation first detected Mar 20 (47 days), R = 0.8 (cholestatic)

**Cholestatic, post-cessation ≤30 days → Score +1**
- DMT stopped Apr 1, bilirubin elevation first detected Apr 25 (24 days post-stop), R = 0.9 (cholestatic)

## Failure modes

- Confusing "first abnormal lab" with "symptom onset" — use the objective lab date, not when the patient felt ill
- Missing or miscalculating the R ratio; if labs are incomplete, mark as ambiguous and ask for clarification
- Multiple DMT switches without clear documentation of which drug was active at injury onset; resolve by using the most recent DMT before injury
- Washout period ambiguity: if injury appears during drug discontinuation (e.g., taper), treat as ongoing exposure unless documented as fully stopped
