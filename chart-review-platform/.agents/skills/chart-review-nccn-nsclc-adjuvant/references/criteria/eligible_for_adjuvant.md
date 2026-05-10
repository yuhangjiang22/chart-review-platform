---
field_id: eligible_for_adjuvant
prompt: Is the patient eligible for NCCN adjuvant chemotherapy after surgical resection?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
---

## Definition

Eligibility per NCCN NSCL-1 (2025): pathologically confirmed NSCLC,
surgically resected with curative intent, final pathologic stage IB
(tumor ≥4 cm), II, or IIIA. Stage IA tumors <4 cm and stage IIIB/IV
disease are NOT eligible per this guideline (different recommendation
pathway).

## Extraction guidance

- Pathology report — final stage (TNM, AJCC 8th edition) post-resection.
- Surgery type — lobectomy, segmentectomy, pneumonectomy. Wedge resection
  alone with no formal sub-/lobectomy is borderline and should escalate.
- Histology — adenocarcinoma, squamous, large-cell, or NOS. Carcinoid /
  small-cell lung cancer are NOT this rubric's scope.
- Margins — R0 (negative) preferred; R1 (microscopic positive) still
  eligible per NCCN if other criteria met.

## Examples

**Satisfying:**
- "Right lower lobectomy 2024-08-15; pathology pT2bN0M0 (stage IIA),
  adenocarcinoma, R0"
- "Left pneumonectomy; pT3N1M0 stage IIIA, squamous"

**Non-satisfying:**
- "Right wedge resection only; stage IA1 (1.5 cm), R0" — stage too low
- "Pleural metastases at thoracotomy; case converted to chemotherapy
  alone" — stage IV
- "Carcinoid tumor, stage I" — wrong histology

## Boundary / failure modes

- Stage IB tumors at exactly 4 cm: per AJCC 8 they are stage IB (4 cm
  cutoff is inclusive); → "yes"
- N2 disease found unexpectedly at surgery: still eligible if completely
  resected → "yes"
- Patient with poor performance status (ECOG ≥2) who would not tolerate
  chemo: still "yes" for ELIGIBILITY; the contraindication is captured
  downstream (deferred to v1).
