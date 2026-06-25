---
field_id: cdr_severity
prompt: CDR severity label (computed).
answer_schema:
  enum: ["normal", "very_mild", "mild", "moderate", "severe"]
cardinality: one
group: staging
derivation: 'cdr_global == "0" ? "normal" : cdr_global == "0.5" ? "very_mild" : cdr_global == "1" ? "mild" : cdr_global == "2" ? "moderate" : "severe"'
required: false
role: interpretive
required_note: "NOT REQUIRED — interpretation band auto-derived from cdr_global; guideline lists severity as context only."
---

# Criterion: cdr_severity (computed)

## Definition

Severity label COMPUTED from `cdr_global` — do NOT answer directly. The label is
auto-derived from the documented global CDR stage per the mapping below; to change
it, fix `cdr_global` and this recomputes.

## Extraction guidance

Mapping (from the `derivation:` in frontmatter): `cdr_global` "0" → `normal`;
"0.5" → `very_mild`; "1" → `mild`; "2" → `moderate`; "3" → `severe`. Do not answer
this field; record `cdr_global` instead. If `cdr_global` is absent/null, this
stays unanswered (Pending) — never a fabricated label.

## Examples

- `cdr_global`="0" → `normal`
- `cdr_global`="0.5" → `very_mild`
- `cdr_global`="1" → `mild`
- `cdr_global`="2" → `moderate`
- `cdr_global`="3" → `severe`
- `cdr_global` absent → Pending (unanswered)
