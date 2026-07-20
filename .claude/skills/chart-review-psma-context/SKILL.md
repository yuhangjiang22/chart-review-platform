---
name: chart-review-psma-context
description: >
  PSMA PET/CT clinical-context chart review. Activate when assembling the
  prostate-cancer context a radiologist needs to interpret a PSMA PET/CT —
  Grade Group, PSA + trend, prior metastatic sites, treatment
  history (prostatectomy, radiation, ADT, ARPI, chemo, radioligand), the scan
  indication, and prior-imaging status — answering the PC0–PC3 chart-review
  questions per patient from pathology, oncology, urology, radiation-oncology,
  and prior imaging notes plus structured EHR data.
---

# PSMA PET/CT context — chart review

For each in-scope patient you answer the FACTUAL questions in
`references/questions/` (the PC0–PC3 checklist). This task provides clinical
context for the interpreting radiologist; it does NOT judge the scan or make
recommendations, so there are no concordance rules to compute.

## Procedure

1. **Eligibility** (`eligibility.yaml`, T0): confirm this exam is a PSMA PET/CT
   and the patient has confirmed prostate adenocarcinoma. Answer first.
2. **Disease + staging** (`disease.yaml`, T1): Grade Group, most-recent PSA +
   trend, prior metastatic sites.
3. **Treatment history** (`treatment.yaml`, T2): prostatectomy, radiation, and
   the STATE (none/active/completed) of ADT, ARPI, chemotherapy, plus prior
   radioligand therapy. Report state, not merely presence — ADT suppresses PSMA
   avidity and changes interpretation.
4. **Exam context** (`exam.yaml`, T3): the indication for THIS scan, the prior
   PET/CT disease status, and any prior-imaging follow-up recommendation (quote
   it verbatim).
5. Cite evidence for every answer: a verbatim **note** quote (pathology /
   oncology / radiology), or a **structured** row (PSA lab / medication /
   procedure) when that is the source. Answer with the exact enum token; put
   detail (dates, drug names, Gleason pattern) in the rationale. If the chart is
   silent, answer `unclear` — never infer from general knowledge.
