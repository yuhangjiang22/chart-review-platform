---
field_id: course_of_liver_injury
prompt: "How did liver enzyme levels change after the MS-DMT was stopped?"
answer_schema:
  type: number
cardinality: one
group: "RUCAM Scoring"
---

# Criterion: Course of Liver Injury

## Definition

This criterion evaluates recovery of liver function after drug cessation. Rapid enzyme decline (≥50% within 8 days for ALT; ≥50% within 180 days for Alk P/bilirubin) strongly supports causality. Persistent elevation or recurrent increase argues against causality. If the drug was never stopped, the course is inconclusive.

## Extraction guidance

Determine whether the MS-DMT was stopped. If yes, collect liver enzyme values (ALT, AST, Alk P, total bilirubin) at: peak during injury, 8 days post-stop (hepatocellular), 30 days post-stop, and 180 days post-stop (cholestatic). Calculate % decrease as [(peak − final) / peak] × 100. For hepatocellular injury, score +3 if ≥50% ALT drop within 8 days; +2 if within 30 days. For cholestatic, score +2 if ≥50% Alk P or bilirubin within 180 days; +1 if <50%. If drug is still active, score 0. Missing follow-up labs → score 0 (inconclusive).

## Examples

**Hepatocellular, ALT ≥50% within 8 days → Score +3**
- Peak ALT 340 U/L (day 5), stop drug day 10, ALT on day 18 = 160 U/L (53% decline in 8 days)

**Hepatocellular, ALT ≥50% within 30 days → Score +2**
- Peak ALT 450 U/L (day 8), stop drug day 12, ALT on day 42 = 200 U/L (56% decline in 30 days)

**Hepatocellular, ALT <50% after 30 days → Score -2**
- Peak ALT 380 U/L, stop day 10, ALT on day 40 = 320 U/L (16% decline after 30 days)

**Cholestatic, Alk P ≥50% within 180 days → Score +2**
- Peak Alk P 280 U/L, stop day 5, Alk P on day 180 = 120 U/L (57% decline)

**Mixed pattern (both ALT and Alk P elevated)**
- ALT shows 60% decline within 30 days (hepatocellular score +2)
- Alk P shows 35% decline by day 180 (cholestatic score +1)
- Use the more favorable (higher) score: +2

**Drug never stopped, enzymes improving → Score 0**
- Patient continues DMT despite abnormal LFTs; trend is improving but score is inconclusive per RUCAM

## Failure modes

- Using peak ALT/Alk P from before or after the injury window; peak must be the highest value during this specific injury episode
- Confusing recovery with baseline — final value should be ULN (upper limit of normal) or patient baseline before injury, not an arbitrary "normal" range
- Missing follow-up labs and guessing; if data unavailable, score as 0 (inconclusive), not negative
- Misidentifying the "stop date" when patient is on taper rather than abrupt cessation; clarify whether truly stopped or dose-reduced
