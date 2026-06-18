---
name: chart-review-lung-cancer-adherence
description: >
  Lung cancer (NSCLC) molecular-testing guideline-concordance review. Activate
  when assessing whether an NSCLC patient's molecular workup adhered to NCCN —
  genomic testing performed, comprehensive genomic profiling vs single-gene,
  PD-L1 IHC, testing-before-therapy sequencing, essential-biomarker
  completeness, and targeted-therapy alignment for actionable mutations —
  answering the MT0–MT12 chart-review questions per patient from pathology,
  molecular/genomics, radiology, and oncology notes plus structured EHR data.
---

# Lung cancer molecular-testing — chart review + NCCN concordance

For each in-scope NSCLC patient you answer the FACTUAL questions in
`references/questions/` (the MT0–MT12 checklist). The NCCN molecular-testing
**concordance verdicts (C1–C6)** are then computed deterministically by the
rule-engine from those facts (`references/rules/concordance.yaml`) — you do not
judge concordance directly.

## Procedure

1. **Eligibility + context** (`eligibility.yaml`, T0): confirm a lung cancer
   diagnosis, the histologic subtype (SCLC vs the NSCLC subtypes), the stage, and
   smoking history. Answer first — histology + stage gate the concordance rules
   (SCLC is generally not required to have molecular testing).
2. **Molecular workup** (`testing.yaml`, T1–T3): was genomic testing performed;
   CGP vs single-gene/panel; tissue vs liquid; was testing ordered / resulted
   before first-line therapy; was PD-L1 IHC performed + its result; the actionable
   findings (gene + variant) and whether any has an FDA-approved targeted therapy.
3. **Treatment alignment** (`treatment.yaml`, T4): targeted therapy for actionable
   mutations, time from diagnosis to first-line therapy (days), genomic turnaround
   (days), and minimum-biomarker completeness when CGP was not done.
4. **Concordance is automatic.** The rule-engine evaluates the seven NCCN rules
   over your answers — each resolves to Concordant / Non-concordant / Excluded
   (key documentation absent), and a non-concordant verdict gets a lung-specific
   attribution category (`references/attribution.yaml`). You do NOT answer these;
   if a verdict looks wrong, correct the underlying abstracted fact.
5. Cite evidence for every answer: a verbatim **note** quote (pathology /
   molecular / radiology / oncology), or a **structured** row (labs/orders) when
   that is the source. Answer with the exact enum token; put detail (vendor, gene
   names, dates) in the rationale. Do not infer from parametric knowledge.

## Concordance rules (computed, not answered)

| Rule | Checks |
|---|---|
| **C1** Testing performed | Molecular testing done when required (NSCLC) |
| **C2** Panel completeness | CGP, or all essential biomarkers individually tested |
| **C3a** Test ordered ≤ therapy | Testing ordered before/at first-line start |
| **C3b** Results ≤ therapy | Results available before first-line start |
| **C4** PD-L1 testing | PD-L1 IHC performed for NSCLC |
| **C5** Time to treatment | Diagnosis → first-line ≤ 60 days |
| **C6** Targeted-therapy alignment | Actionable mutation got recommended first-line targeted therapy |

Out of scope: the experiment's benchmark harness, annotation tooling, and
scoring scripts — this package is the question + rule rubric only.
