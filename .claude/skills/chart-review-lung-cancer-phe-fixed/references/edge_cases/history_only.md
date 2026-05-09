---
id: history_only
pattern: "History of lung cancer mentioned but current status unclear"
applies_to:
  - lung_cancer_pathology_present
  - lung_cancer_clinical_mention
failure_mode: "Misclassifying a patient with past cancer as currently confirmed when the guideline is meant to assess current malignancy status"
correct_answer_hint: "If the patient explicitly states or chart documents 'history of lung cancer' or 'treated 5 years ago with no current evidence of recurrence,' classify as 'Confirmed (historical)' or note the temporal qualifier. If unclear whether disease is current or remission, escalate to 'Probable' pending clarification."
---

# Edge Case: history_only

## Pattern

The chart mentions lung cancer explicitly but the temporal qualifier indicates past diagnosis (e.g., "history of," "prior," "treated years ago," "no current evidence of recurrence").

## Why it matters

A patient with a history of treated lung cancer—especially if currently disease-free—may be classified differently depending on whether the research question is about **ever having lung cancer** (should be "Confirmed") vs. **current active malignancy** (should be "Absent" if in remission). The guideline's scope is current lung cancer status, so historical disease without evidence of current activity should not automatically trigger "Confirmed" unless recurrence is documented.

## How to handle

- If the chart explicitly states "no evidence of recurrence" or "complete remission," classify as "Absent" (current status).
- If the chart documents "on surveillance" without interval recurrence, classify as "Absent" (current status).
- If recurrence or progression is documented, revert to "Confirmed" or "Probable" per the leaf criteria.
- When ambiguous (e.g., "history of lung cancer; current status pending follow-up imaging"), classify as "Probable" and flag for adjudication.
