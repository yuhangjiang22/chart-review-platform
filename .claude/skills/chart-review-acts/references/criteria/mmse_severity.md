---
field_id: mmse_severity
prompt: MMSE severity band (computed).
answer_schema:
  enum: ["normal", "mild", "moderate", "severe"]
cardinality: one
group: cognitive_scales
derivation: 'mmse_score >= 24 ? "normal" : mmse_score >= 19 ? "mild" : mmse_score >= 10 ? "moderate" : "severe"'
required: false
role: interpretive
required_note: "NOT REQUIRED — interpretation band auto-derived from mmse_score; guideline lists severity as context only."
---

# Criterion: mmse_severity (computed)

## Definition

Severity band COMPUTED from `mmse_score` — do NOT answer directly. The band is
auto-derived from the documented MMSE score per the cutoffs below; to change it,
fix `mmse_score` and this recomputes.

## Extraction guidance

Cutoffs (from the `derivation:` in frontmatter): `mmse_score` ≥ 24 → `normal`;
19–23 → `mild`; 10–18 → `moderate`; 0–9 (≤9) → `severe`. Do not answer this field;
record `mmse_score` instead. If `mmse_score` is absent/null, this stays unanswered
(Pending) — never a fabricated band.

## Examples

- `mmse_score`=27 → `normal`
- `mmse_score`=21 → `mild`
- `mmse_score`=14 → `moderate`
- `mmse_score`=7 → `severe`
- `mmse_score` absent → Pending (unanswered)
