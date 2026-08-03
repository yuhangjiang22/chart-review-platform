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
`references/questions/`, in two tiers: confirm eligibility, then **abstract the
STORE 2025 data elements** (the core chart-review questions). The **NCCN
concordance** verdicts are then computed deterministically by the rule-engine
from those facts (`references/rules/concordance.yaml`) — you do not judge
concordance directly.

## Procedure

1. **Eligibility + context** (`eligibility.yaml`, T0): confirm this is a CRC
   case, the subsite (colon vs. rectal), and the AJCC stage group. Answer first —
   these gate scope and set the N/A (Excluded) conditions for the
   stage-conditional rules.
2. **Abstraction** (`abstraction.yaml`, T1) — the core chart-review questions:
   abstract the STORE 2025 data elements (primary site, histology, grade, TNM,
   LVI, node counts, margins, MSI/MMR, surgery, chemo, radiation) plus the
   baseline staging facts (cross-sectional imaging, baseline CEA). Answer
   verbatim where possible — **these facts feed the concordance rules, so
   accuracy here drives the verdicts.**
3. **Concordance is automatic.** The rule-engine evaluates the five NCCN rules in
   `references/rules/concordance.yaml` over your eligibility + abstraction
   answers — each resolves to Concordant / Non-concordant / Excluded (N/A), and a
   non-concordant verdict gets an attribution category
   (`references/attribution.yaml`). You do NOT answer these; if a verdict looks
   wrong, correct the underlying abstracted fact.
4. Cite evidence for every abstraction answer: a verbatim **note** quote (path /
   radiology / oncology / operative), or a **structured** row (labs/orders) when
   that is the source. Do not infer from parametric knowledge.

## Scope (from the CRC EvoSkill design)

- **Abstraction (Section 2, Domains 1–4):** ~18 STORE data elements across cancer
  identification, staging (TNM), surgical/pathologic features, first-course
  treatment, and baseline staging workup — the primary chart-review questions
  (the only thing the agent answers).
- **Concordance (Section 3):** five NCCN rules computed by the rule-engine —
  MSI/MMR testing, staging-workup completeness, ≥12-node harvest, Stage III
  adjuvant chemo, locally-advanced rectal neoadjuvant chemoradiation.

Intentionally **out of scope:** the study's baselines / Base+Human-Skills /
EvoSkill conditions, difficulty levels, data-prep/linkage, train-val-test, and
evaluation metrics — this package is the task rubric only.
