---
field_id: risk_factors
prompt: "What standard and MS-specific risk factors does the patient have?"
answer_schema:
  type: string
cardinality: one
group: "RUCAM Scoring"
time_window_check: skip
---

# Criterion: Risk Factors

## Definition

This criterion captures standard RUCAM risk factors (alcohol use, pregnancy, age ≥55) that increase baseline susceptibility to DILI, plus six MS-specific risk factors unique to this population. Standard factors contribute +1 each if present. MS-specific factors are documented as context but do not add numeric points to the RUCAM score—they inform clinical judgment about susceptibility and causality strength.

## Extraction guidance

**Standard RUCAM scoring (+1 each if present):**
- Hepatocellular type: +1 for documented chronic ethanol use OR AST/ALT ≥2
- Cholestatic/mixed type: +1 for ethanol OR pregnancy
- All types: +1 if age ≥55 at injury onset

**MS-specific risk factors (document presence/absence):**
1. Pre-existing liver disease or cirrhosis (ICD codes K70–K77, imaging, biopsy, or documented diagnosis)
2. Concurrent hepatotoxic medications (cross-reference medication list against known hepatotoxins)
3. History of autoimmune hepatitis (ICD K75.4, autoimmune serology, biopsy, or diagnosis note)
4. Immunosuppression or concomitant immunosuppressive therapy (corticosteroids, azathioprine, mycophenolate, CD4 if HIV+)
5. Prior DILI or drug hypersensitivity reaction (documented ADR, prior hospitalization for drug reaction, historical notes)
6. Pre-existing autoimmune disease beyond MS (lupus, RA, Sjögren's, PBC, PSC, or equivalent diagnosis code)

## Examples

**Standard factors alone:**
- 55-year-old, no alcohol use, not pregnant → +0
- 60-year-old, heavy drinking (documented), AST/ALT = 2.5 (hepatocellular) → +2 (age ≥55 + alcohol)
- 50-year-old female, 8 weeks pregnant, no alcohol (cholestatic injury) → +1 (pregnancy)

**MS-specific risk factors (no numeric addition, contextual note):**
- Patient has pre-existing cirrhosis (documented on imaging) + prior DILI with amoxicillin (documented in chart) → Note: High genetic predisposition to idiosyncratic DILI
- Patient on corticosteroids for MS relapse, concurrent with DMT → Note: Immunosuppression may increase susceptibility
- Patient has concurrent lupus (ICD M32) and autoimmune hepatitis serology positive → Note: Autoimmune activation may confound causality

**Combined example:**
- 58-year-old, moderate alcohol use (AST/ALT = 1.8, documented), history of drug hypersensitivity, pre-existing autoimmune thyroiditis
- Standard score: +1 (age ≥55)
- MS-specific: prior drug hypersensitivity + autoimmune disease → context for genetic DILI susceptibility

## Failure modes

- Scoring MS-specific risk factors as additional numeric points (they are contextual, not point-adding)
- Confusing "on corticosteroid" with "immunocompromised state" — document the specific immunosuppressive agent and its intensity
- Missing alcohol history in social history; look for AST/ALT ratio, addiction notes, or family history of alcoholism if patient denies
- Assuming age <55 = 0 without verification; always confirm patient's age at the time of injury onset
- Overlooking prior autoimmune serologies or incomplete hepatitis workup; flag if ANA, anti-smooth muscle, or anti-mitochondrial not tested
