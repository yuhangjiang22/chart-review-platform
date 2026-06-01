---
field_id: exclusion_of_other_causes
prompt: "How many alternative causes of liver injury have been ruled out?"
answer_schema:
  type: number
cardinality: one
group: "RUCAM Scoring"
---

# Criterion: Exclusion of Other Causes

## Definition

Strong DILI causality requires ruling out common, important alternative diagnoses. This criterion scores based on how thoroughly the chart documents exclusion of Group I causes (viral hepatitis, biliary obstruction, alcoholism, shock/ischemia, autoimmune hepatitis, other autoimmune liver disease) and Group II causes (sepsis, chronic viral hepatitis, CMV/EBV/HSV infection, malignancy). Comprehensive exclusion (+2) strongly supports MS-DMT causality; incomplete exclusion (0 or −2) leaves alternative diagnoses plausible.

## Extraction guidance

**Group I (6 causes) — look for:**
1. Viral serology: IgM anti-HAV, HBsAg, anti-HBc (HBV); anti-HCV, HCV RNA (HCV) — all negative
2. Imaging for biliary obstruction: ultrasound, CT, or MRCP showing no ductal dilation, stones, or malignancy
3. Alcohol use history: <14 drinks/week (female) or <21 drinks/week (male), AND AST/ALT <2
4. Shock/ischemia: no ICU admission, hypotension, or lactate elevation within 2 weeks of injury onset
5. Autoimmune markers: negative ANA, anti-smooth muscle, anti-LKM (or biopsy showing no inflammation if tested)
6. No PBC (negative anti-mitochondrial antibody) or PSC (normal cholangiography or no documented diagnosis)

**Group II (2 categories) — look for:**
- No documented sepsis, chronic hepatitis, cirrhosis, malignancy, or complications of underlying disease
- Negative serology or PCR for acute CMV, EBV, or HSV; no clinical signs of acute viral infection

**Scoring:**
- +2: All Group I (all 6) and Group II (both) ruled out
- +1: All Group I ruled out, some or all Group II ruled out
- 0: 4–5 Group I ruled out, multiple alternatives remain
- −2: <4 Group I ruled out, or strong evidence of alternative diagnosis (e.g., confirmed viral hepatitis)

## Examples

**Comprehensive exclusion → Score +2**
- Hepatitis A/B/C serology: all negative; ultrasound: no biliary dilation, no stones; alcohol: denies heavy use, AST/ALT = 1.2; no recent shock; autoimmune serology: ANA, anti-smooth muscle negative; CMV/EBV/HSV: negative serology; no sepsis or malignancy documented

**Partial exclusion (Group I complete) → Score +1**
- All 6 Group I causes ruled out; however, no documentation of CMV/EBV testing (Group II incomplete but less concerning)

**Incomplete exclusion → Score 0**
- Hepatitis A/B/C serology done: all negative
- Biliary imaging: done, normal
- Alcohol: no documentation in chart
- Shock/ischemia: not documented
- Autoimmune serology: not done
- Only 2–3 of Group I reliably ruled out

**Alternative diagnosis confirmed → Score −2**
- Patient tested positive for HCV antibody and HCV RNA → Hepatitis C is the primary cause; MS-DMT causality downgraded
- Imaging shows common bile duct obstruction by gallstone → Biliary obstruction is primary; MS-DMT less likely

## Failure modes

- Assuming "not documented" = "ruled out" — absence of a test is not the same as a negative test
- Conflating distant viral serology (prior immunity, resolved infection) with acute infection; IgM serology specifically indicates acute infection
- Missing autoimmune serology if not explicitly ordered; flag as open question rather than assuming negative
- Assuming a patient without documented sepsis or malignancy is definitely excluded from those diagnoses; absence of documentation ≠ absence of disease
- Not asking about overseas travel, blood transfusions, or IVDU history when assessing viral hepatitis risk
