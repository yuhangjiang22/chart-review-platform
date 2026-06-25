---
field_id: smoking_status
prompt: What is the patient's documented smoking status?
answer_schema:
  enum: ["current", "former", "never", "unknown"]
cardinality: one
group: demographics
---

# Criterion: smoking_status

## Definition

The patient's documented **tobacco smoking status**, captured as one of four
values:
- `current` — current smoker / active tobacco use.
- `former` — quit / ex-smoker / past tobacco use, not current.
- `never` — never smoked / denies tobacco use.
- `unknown` — status not documented or genuinely unclear.

Use the patient's own status only — never family history.

## Extraction guidance

Map the documented phrasing to a value:
- "denies tobacco" / "never smoker" / "no history of smoking" → `never`.
- "quit 2015" / "former smoker" / "ex-smoker" / "past tobacco use" → `former`.
- "1 ppd" / "current smoker" / "smokes" / "active tobacco use" → `current`.
- Nothing documented about smoking, or genuinely ambiguous → `unknown`.

A patient who quit takes precedence over any residual "smoker" language: "ex-smoker,
quit 2 years ago" → `former`, not `current`. Use only the patient's status; a family
history of smoking does not set this field.

**Evidence:** cite the smoking-status span.

## Examples

- "Denies tobacco use." → `never`
- "Never smoker." → `never`
- "Former smoker, quit in 2015." → `former`
- "Ex-smoker." → `former`
- "Smokes 1 ppd." → `current`
