---
name: chart-review-crc-nccn-adherence
description: >
  Colorectal cancer (CRC) NCCN guideline-concordance review. Activate when
  assessing whether a CRC patient's care adhered to NCCN — molecular (MSI/MMR)
  testing, staging workup, adequate lymph-node harvest, and stage-appropriate
  adjuvant chemo / neoadjuvant chemoradiation — answering concordance questions
  per patient from pathology, radiology, oncology, and operative notes plus
  structured EHR data.
---

# CRC chart review — STORE abstraction + NCCN concordance

For each in-scope CRC patient you answer the questions in
`references/questions/`, in three tiers: confirm eligibility, **abstract the
STORE 2025 data elements** (the core chart-review questions), then judge the
**NCCN concordance** rules (derived from the abstracted answers).

## Procedure

1. **Eligibility + context** (`eligibility.yaml`, T0): confirm this is a CRC
   case, the subsite (colon vs. rectal), and the AJCC stage group. Answer first —
   these gate scope and set the N/A conditions for the stage-conditional rules.
2. **Abstraction** (`abstraction.yaml`, T1) — the core chart-review questions:
   abstract the STORE 2025 data elements (primary site, histology, grade, TNM,
   LVI, node counts, margins, MSI/MMR, surgery, chemo, radiation) from the source
   documents. Answer verbatim where possible.
3. **Concordance** (`concordance.yaml`, T2): answer each NCCN rule —
   Concordant / Discordant / Not-applicable — derived from the T1 answers; apply
   its N/A condition first. If the deciding evidence is genuinely absent, say so
   in the rationale rather than guessing.
4. Cite evidence for every answer: a verbatim **note** quote (path / radiology /
   oncology / operative), or a **structured** row (labs/orders) when that is the
   source. Do not infer from parametric knowledge.

## Scope (from the CRC EvoSkill design)

- **Abstraction (Section 2, Domains 1–4):** ~16 STORE data elements across cancer
  identification, staging (TNM), surgical/pathologic features, and first-course
  treatment — the primary chart-review questions.
- **Concordance (Section 3):** five NCCN rules — MSI/MMR testing, staging-workup
  completeness, ≥12-node harvest, Stage III adjuvant chemo, locally-advanced
  rectal neoadjuvant chemoradiation.

Intentionally **out of scope:** the study's baselines / Base+Human-Skills /
EvoSkill conditions, difficulty levels, data-prep/linkage, train-val-test, and
evaluation metrics — this package is the task rubric only.
