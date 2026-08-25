---
field_id: biopsy_recent_cirrhosis
prompt: Liver biopsy within 5 years of index showing METAVIR stage 4 or Ishak stage 5-6?
answer_schema:
  enum: [yes, no]
cardinality: one
group: step1
---

# Criterion: biopsy_recent_cirrhosis

## Definition
A **liver biopsy within 5 years** of the index date demonstrating **METAVIR
stage 4** or **Ishak stage 5-6** (cirrhosis). Per the LCN definition this is
**sufficient alone** to establish Step-1 cirrhosis — no other criterion needed.

## Extraction guidance
**Always commit one value:**
- **`yes`** — a pathology report (or a clinician's citation of one) dated
  within 5 years BEFORE the index date stages the liver METAVIR 4 or Ishak 5-6.
- **`no`** — no such biopsy in the window (including: biopsy exists but stage
  below the threshold, or biopsy older than 5 years — that belongs to
  `crit_e_biopsy_old`).
Cite the pathology note span (stage wording verbatim) or the procedure row +
note. State the biopsy date and confirm it is within 5 years of index.

## Examples
- "Liver biopsy (2023-04): stage 4/4 fibrosis (METAVIR), consistent with cirrhosis", index 2025-06 -> `yes`
- "Biopsy 2015: Ishak 6" with index 2025 -> `no` (older than 5y; see crit_e_biopsy_old)
- "Biopsy: METAVIR F3" -> `no` (below threshold)

## Window anchor (v0.4)
The lookback window for THIS met/not_met answer is anchored to the
**reference date** (`demographics.reference_date`; in legacy extracts where it
is absent, the index date). This enum is a calibration snapshot — the dated
evidence for the outcome scan goes in the companion _date field, which is
WINDOWLESS (see that field's guidance).
