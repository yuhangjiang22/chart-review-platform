---
field_id: lung_cancer_clinical_mention
prompt: "Is lung cancer explicitly mentioned in a clinical diagnosis or assessment?"
answer_schema:
  type: enum
  enum: [yes, no, no_info]
cardinality: one
time_window: baseline
group: "Clinical Documentation"
uses:
  code_sets:
    - lung_cancer_icd10
---

# Criterion: lung_cancer_clinical_mention

## Definition

"Yes" means a provider (physician, nurse practitioner, PA) explicitly states in a clinical note, problem list, or assessment that the patient has or is suspected to have lung cancer (including NSCLC, SCLC, or pulmonary malignancy). "No" means charts explicitly rule out lung cancer or document no suspicion of malignancy. "No_info" means no explicit clinical mention or assessment is documented.

## Extraction guidance

Search progress notes, history & physical, oncology/pulmonology assessments, problem lists, and discharge summaries. Look for phrases like "lung cancer," "NSCLC," "SCLC," "pulmonary malignancy," "suspected malignancy," "malignant tumor of the lung," or the diagnosis appended to the assessment. Include explicit ICD-9/ICD-10 code assignments if documented. Exclude vague language like "rule out malignancy" without provider assertion; include language like "concern for" or "suspected" as clinical mention.

## Examples

**Satisfying**
- Assessment: "Lung cancer, stage IIIA NSCLC" → yes
- Progress note: "Patient with newly diagnosed adenocarcinoma of the lung, referral to oncology" → yes
- Problem list entry: "Malignant neoplasm of right lower lobe" → yes

**Non-satisfying**
- "Rule out lung cancer; chest CT ordered" → no_info (workup pending, not yet stated as diagnosis)
- "No active malignancy" → no (explicitly ruled out)
- "Nodule on prior imaging, stable; believed to be benign" → no (benign characterization)

**Boundary**
- "Suspected lung cancer pending pathology confirmation" → yes (clinical suspicion documented by provider)
- "History of lung cancer; treated 5 years ago, no current evidence of recurrence" → yes (cancer documented, even if historical)

## Failure modes

- Interpreting "nodule" or "mass" mentioned without explicit "cancer" or "malignancy" as clinical mention (may be radiologic finding only)
- Including only family history ("mother had lung cancer") as personal diagnosis
- Marking "yes" for incidental mention of lung cancer in unrelated clinical context (e.g., "compared to lung cancer patient") without personal assertion
