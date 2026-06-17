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

# CRC NCCN concordance review

This task scores **guideline concordance**, not tumor-registry abstraction.
For each in-scope CRC patient you answer the questions in
`references/questions/`, each as **Concordant**, **Discordant**, or
**Not applicable** (with a stated N/A condition).

## Procedure

1. **Eligibility + context** (`references/questions/eligibility.yaml`):
   confirm this is a CRC case, the subsite (colon vs. rectal), and the AJCC
   stage group. These set the N/A conditions for the stage-conditional rules —
   answer them first.
2. **Concordance** (`references/questions/concordance.yaml`): answer each rule.
   Apply its N/A condition before judging concordant/discordant. If the
   evidence to decide is genuinely absent from the chart, say so in the
   rationale rather than guessing.
3. Cite evidence for every answer: a verbatim **note** quote (path / radiology /
   oncology / operative), or a **structured** row (labs/orders) when that is the
   source. Do not infer from parametric knowledge.

## Scope (from the CRC EvoSkill design, Section 3)

Five NCCN concordance rules: MSI/MMR testing performed; staging workup
completeness (CT chest/abdomen/pelvis + CEA); regional lymph-node harvest
adequacy (≥12 nodes); Stage III adjuvant chemotherapy; locally-advanced rectal
neoadjuvant chemoradiation. The study's abstraction targets, evaluation
methodology, and EvoSkill machinery are intentionally **out of scope** here —
this package is the concordance task only.
