---
field_id: abnormal_liver_function
prompt: Does the patient have abnormal liver function (cirrhosis, bilirubin > 2× ULN, or AST/ALT > 3× ULN)?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: lookback_lifetime
---

## Definition

The HAS-BLED A component (liver half) scores 1 point if any of:
1. Chronic liver disease (cirrhosis, biopsy-proven hepatic fibrosis)
2. Total bilirubin > 2× ULN
3. AST or ALT > 3× ULN

Lab abnormalities should be sustained / recent (most recent value within
the lookback window), not one-off transient bumps.

## Extraction guidance

- Search problem list / ICD-10: K70.x (alcohol-related), K72.x (hepatic
  failure), K74.x (cirrhosis), K76.x (other liver disease)
- Most recent bilirubin / AST / ALT within 10-year lookback; use lab's
  reported ULN
- Imaging or biopsy report mentioning cirrhosis

## Examples

**Satisfying ("yes"):**
- "Cirrhosis from chronic HCV" → yes
- "Bilirubin 3.2 (ULN 1.2) on most recent labs" → yes (>2× ULN)
- "AST 180 (ULN 40) and ALT 220 (ULN 40)" → yes (both > 3× ULN)

**Non-satisfying ("no"):**
- "Mild fatty liver on US" without cirrhosis or lab abnormalities → no
- "Transient AST 90 during acute illness, normalized" → no
- "Bilirubin 2.0 (ULN 1.2)" → no (only 1.7× ULN)

## Boundary / failure modes

- Bilirubin exactly 2× ULN → "no" (HAS-BLED uses > 2×, strict)
- Resolved hepatitis A with normal current labs → "no"
- Patient on hepatotoxic drug with abnormal labs but no chronic disease
  → "yes" if the abnormality persists over the window
