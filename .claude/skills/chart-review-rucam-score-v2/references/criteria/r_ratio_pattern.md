---
field_id: r_ratio_pattern
prompt: What is the pattern of liver injury based on the R-ratio (ALT/ULN ÷ ALP/ULN) at first presentation?
answer_schema:
  type: enum
  enum: [hepatocellular, cholestatic, mixed]
is_final_output: false
---

## Definition

The R-ratio classifies the pattern of liver enzyme abnormality at first
presentation. RUCAM uses different scoring tables for hepatocellular vs
cholestatic patterns (mixed uses the cholestatic table per Danan/Teschke
2016). v0 of this rubric supports hepatocellular only; cholestatic and
mixed are flagged for follow-up.

R = (ALT / ULN_ALT) ÷ (ALP / ULN_ALP)

- R ≥ 5 → hepatocellular
- R ≤ 2 → cholestatic
- 2 < R < 5 → mixed

## Extraction guidance

- Find the FIRST set of ALT and ALP values at or after the suspected injury
  presentation (within 7 days of first abnormality).
- Use the laboratory's reported ULN; do not assume a fixed ULN.
- Both ALT and ALP must be available in the same time window. If only ALT
  is documented, the pattern cannot be classified — escalate.

## Examples

**Hepatocellular:**
- ALT 480 (ULN 40, ratio 12) and ALP 120 (ULN 130, ratio 0.92) → R = 12 / 0.92 ≈ 13 → hepatocellular

**Cholestatic:**
- ALT 80 (ULN 40, ratio 2.0) and ALP 600 (ULN 130, ratio 4.6) → R = 2.0 / 4.6 ≈ 0.43 → cholestatic

**Mixed:**
- ALT 200 (ULN 40, ratio 5.0) and ALP 300 (ULN 130, ratio 2.3) → R ≈ 2.17 → mixed

## Boundary / failure modes

- If ALP is not measured, use γGT as a proxy ONLY if explicitly noted in the
  chart; otherwise escalate.
- If R is exactly 5.0 or 2.0, classify per the inequality (≥5 → hepatocellular;
  ≤2 → cholestatic).
