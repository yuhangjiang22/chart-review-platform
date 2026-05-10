---
field_id: alt_causes_score
prompt: What RUCAM "exclusion of alternative causes" score does the workup earn?
answer_schema:
  type: integer
  minimum: -3
  maximum: 2
is_final_output: false
time_window: peri_drug
---

## Definition

RUCAM's component 5 scores how thoroughly alternative causes of liver
injury were ruled out:

| Workup completeness | Score |
|---|---|
| Group I (HAV, HBV, HCV, biliary US, alcohol) AND Group II (CMV, EBV, HSV, autoimmune, hereditary, hemodynamic) all excluded | +2 |
| Group I excluded; Group II not done | +1 |
| 4–5 of 6 Group I causes excluded | 0 |
| ≤3 of 6 Group I causes excluded | −2 |
| Alternative cause highly probable / confirmed | −3 |

Group I causes (must be tested):
1. Acute hepatitis A (HAV IgM)
2. Acute hepatitis B (HBsAg, HBcIgM)
3. Acute hepatitis C (HCV RNA)
4. Biliary obstruction (abdominal ultrasound)
5. Alcohol use ≥3 drinks/day (women) or ≥4 (men)
6. Recent hypotension / shock liver

Group II (optional but bumps score to +2):
- CMV / EBV / HSV serologies
- Autoimmune hepatitis panel (ANA, ASMA, IgG)
- Hereditary (ferritin, ceruloplasmin, AAT)

## Extraction guidance

- Search hospital labs and outpatient orders within ±30 days of injury onset.
- "Excluded" means a result was obtained AND was negative or normal.
- "Alternative cause highly probable" means a clinician documented the
  alternative cause as the actual diagnosis (not merely suspected).

## Examples

- HAV/HBV/HCV serologies all negative; abdominal US shows no obstruction;
  patient is non-drinker with no shock → 5 of 6 Group I, no Group II → 0
- All 6 Group I excluded + CMV/EBV/AIH negative → +2
- HAV/HBV/HCV negative; no US done; alcohol use unclear → 3 of 6 Group I → −2
- Acute HCV confirmed by HCV RNA → −3 (alternative cause confirmed)

## Boundary / failure modes

- If the chart says "viral hepatitis ruled out clinically" without lab
  documentation, do NOT count Group I as excluded.
- If autoimmune labs show borderline positivity (e.g. ANA 1:80 only),
  consider Group II partially excluded; clinician judgment decides.
