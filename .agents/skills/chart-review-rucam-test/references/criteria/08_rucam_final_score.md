---
field_id: rucam_final_score
prompt: "What is the final RUCAM causality score?"
answer_schema:
  type: number
cardinality: one
group: "RUCAM Output"
is_final_output: true
time_window_check: skip
derivation:
  kind: expression
  expr: |
    time_to_onset + course_of_liver_injury + risk_factors + concomitant_drugs +
    exclusion_of_other_causes + previous_hepatotoxicity_info + response_to_readministration
  truth_table:
    - inputs:
        time_to_onset: 2
        course_of_liver_injury: 2
        risk_factors: 1
        concomitant_drugs: 0
        exclusion_of_other_causes: 2
        previous_hepatotoxicity_info: 2
        response_to_readministration: 0
      output: 9
      note: "Definite causality (RUCAM ≥9)"
    - inputs:
        time_to_onset: 1
        course_of_liver_injury: 0
        risk_factors: 0
        concomitant_drugs: -1
        exclusion_of_other_causes: 1
        previous_hepatotoxicity_info: 1
        response_to_readministration: 0
      output: 2
      note: "Unlikely causality (RUCAM 1–2)"
    - inputs:
        time_to_onset: -2
        course_of_liver_injury: 2
        risk_factors: 0
        concomitant_drugs: -2
        exclusion_of_other_causes: 1
        previous_hepatotoxicity_info: 0
        response_to_readministration: 0
      output: -1
      note: "Excluded causality (RUCAM ≤0)"
---

# Criterion: RUCAM Final Score

## Definition

The RUCAM final score is the sum of all seven RUCAM component scores. It represents the likelihood that the observed liver injury in the patient is causally related to the suspect MS-DMT, where higher scores indicate stronger causality. The final score determines the causality category: ≤0 = Excluded, 1–2 = Unlikely, 3–4 = Possible, 5–8 = Probable, ≥9 = Definite.

## Extraction guidance

This is a derived criterion—do not assess it independently. The score is automatically computed by summing:
- Criterion 1 (Time to Onset): [−2, 0, +1, +2]
- Criterion 2 (Course): [−2, 0, +1, +2, +3]
- Criterion 3 (Risk Factors): [0, +1]
- Criterion 4 (Concomitant Drugs): [−3, −2, −1, 0]
- Criterion 5 (Exclusion of Other Causes): [−2, 0, +1, +2]
- Criterion 6 (Previous Hepatotoxicity Info): [0, +1, +2]
- Criterion 7 (Response to Readministration): [−2, 0, +1, +3]

**Theoretical range:** −10 to +14

## Examples

**Definite DILI (score ≥9)**
- Time to onset: +2 (5–90 days from start, hepatocellular)
- Course: +2 (ALT ≥50% within 30 days)
- Risk factors: +1 (age ≥55)
- Concomitant drugs: 0 (no hepatotoxic concomitants)
- Exclusion of other causes: +2 (all Group I and II ruled out)
- Previous hepatotoxicity: +2 (hepatotoxicity labeled for this DMT)
- Readministration: 0 (not done)
- **Total: +2+2+1+0+2+2+0 = +9 → Definite**

**Possible DILI (score 3–4)**
- Time to onset: +1 (compatible post-cessation, ≤15 days)
- Course: 0 (incomplete follow-up labs)
- Risk factors: 0 (no standard risk factors)
- Concomitant drugs: −1 (suggestive concomitant drug with compatible timing)
- Exclusion of other causes: +1 (Group I mostly ruled out, Group II partial)
- Previous hepatotoxicity: +1 (published case reports, not labeled)
- Readministration: 0 (not done)
- **Total: +1+0+0−1+1+1+0 = +2 → Unlikely**

**Excluded DILI (score ≤0)**
- Time to onset: −2 (>15 days post-cessation)
- Course: +2 (recovery documented)
- Risk factors: 0 (no standard risk factors)
- Concomitant drugs: −2 (known hepatotoxic drug with suggestive timing)
- Exclusion of other causes: +1 (Group I mostly ruled out)
- Previous hepatotoxicity: 0 (no documented hepatotoxicity for this DMT)
- Readministration: 0 (not done)
- **Total: −2+2+0−2+1+0+0 = −1 → Excluded**

## Failure modes

- Computing the score manually and introducing arithmetic errors — rely on the automated summation
- Misinterpreting the score (e.g., thinking "score of 5" means "5% likely" rather than "probable causality")
- Confusing the numeric RUCAM score with diagnostic certainty; a score of 3–4 (Possible) is not ruled out, just lower confidence
- Failing to recognize that a single −3 or −2 can shift the overall causality category (e.g., −2 for time to onset → Excluded, even if other scores are positive)
- Reporting the score without context; always interpret alongside the seven component scores for transparency
