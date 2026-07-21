---
field_id: moca_severity
prompt: MoCA severity band (computed).
answer_schema:
  enum: ["normal", "mild", "moderate", "severe", "no_info"]
cardinality: one
group: cognitive_scales
derivation: 'moca_score >= 26 ? "normal" : moca_score >= 18 ? "mild" : moca_score >= 10 ? "moderate" : moca_score >= 0 ? "severe" : "no_info"'
required: false
role: interpretive
required_note: "NOT REQUIRED — interpretation band auto-derived from moca_score; guideline lists severity as context only."
---

# Criterion: moca_severity (computed)

## Definition

Severity band COMPUTED from `moca_score` — do NOT answer directly. The band is
auto-derived from the documented MoCA score per the official cutoffs; to change
it, fix `moca_score` and this recomputes.

## Extraction guidance

Cutoffs (from the `derivation:` in frontmatter): `moca_score` ≥ 26 → `normal`;
18–25 → `mild`; 10–17 → `moderate`; 0–9 → `severe`. Do not answer this field;
record `moca_score` instead. If `moca_score` is absent/null, this stays
unanswered (Pending) — never a fabricated band.

## Examples

- `moca_score`=28 → `normal`
- `moca_score`=22 → `mild`
- `moca_score`=14 → `moderate`
- `moca_score`=6 → `severe`
- `moca_score` absent → Pending (unanswered)
