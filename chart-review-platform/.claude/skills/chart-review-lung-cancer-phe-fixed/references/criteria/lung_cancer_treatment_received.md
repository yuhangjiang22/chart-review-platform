---
field_id: lung_cancer_treatment_received
prompt: "Has the patient received lung cancer-directed treatment?"
answer_schema:
  type: enum
  enum: [yes, no, no_info]
cardinality: one
time_window: baseline
group: "Treatment Evidence"
---

# Criterion: lung_cancer_treatment_received

## Definition

"Yes" means the patient has received systemic therapy (chemotherapy, targeted therapy, immunotherapy), radiation therapy to the chest, or surgical resection documented in the context of lung cancer. "No" means no such treatments are documented, or treatments were given for non-cancer indications. "No_info" means treatment history is not documented or unclear.

## Extraction guidance

Extract from oncology notes, treatment summaries, medication lists, and surgical/procedure records. Look for chemotherapy agents (e.g., cisplatin, pemetrexed, carboplatin), targeted therapies (e.g., erlotinib, gefitinib, ALK inhibitors), immunotherapies (e.g., nivolumab, pembrolizumab), radiation therapy dates and targets, and surgical notes mentioning lung resection or lobectomy. Cross-reference with problem list and ICD codes. Exclude supportive care (e.g., supplemental oxygen, steroids for COPD) unless explicitly linked to cancer treatment.

## Examples

**Satisfying**
- "Patient started on carboplatin + pemetrexed for stage IIIA NSCLC on [date]" → yes
- "Chest radiation therapy completed: 60 Gy to right upper lobe tumor" → yes
- "Surgical report: left upper lobectomy with mediastinal lymph node dissection for lung cancer" → yes

**Non-satisfying**
- "Supplemental oxygen prescribed for hypoxemia" → no (supportive care, not cancer-directed)
- "Steroid taper for COPD exacerbation" → no (not cancer-directed)
- No mention of cancer-directed therapy in available records → no

**Boundary**
- "Offered chemotherapy; patient declined; supportive care only" → no (treatment offered but not received)
- "Radiation therapy to chest 10 years ago for Hodgkin lymphoma" → no (cancer-directed, but not for lung cancer)

## Failure modes

- Including palliative care alone (e.g., hospice, pain management) as cancer-directed treatment
- Confusing chemotherapy for a non-lung cancer with lung cancer therapy
- Marking "yes" for treatment discussed or planned without documentation of actual administration
