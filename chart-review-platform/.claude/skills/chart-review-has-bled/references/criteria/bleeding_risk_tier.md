---
field_id: bleeding_risk_tier
prompt: What bleeding-risk tier does the HAS-BLED total score place this patient in?
answer_schema:
  type: enum
  enum: [low, intermediate, high]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if has_bled_score <= 1 then "low"
    else if has_bled_score == 2 then "intermediate"
    else "high"
---

## Definition

Bleeding-risk tier per the canonical HAS-BLED cutoffs (Pisters 2010):

- **low** — total 0–1 (annual major-bleed risk ~1%)
- **intermediate** — total 2 (~2%)
- **high** — total ≥ 3 (~3.7% for score 3, rising with each additional
  point)

A "high" score does NOT itself contraindicate anticoagulation per
modern guidance — the score's job is to flag patients for closer
monitoring (more frequent INR checks, BP control optimization,
cessation of concomitant antiplatelet/NSAID where possible).

## Extraction guidance

Derived field. Reviewers should not override unless a leaf was scored
incorrectly — fix the leaf.

## Examples

- score 0 or 1 → low
- score 2 → intermediate
- score 4 → high
- score 9 → high

## Boundary / failure modes

- Score = 1: at the boundary between low and intermediate. Pisters used
  0–1 as low; we follow that.
- Score = 3: high (the threshold for "more careful monitoring"
  recommendations).
