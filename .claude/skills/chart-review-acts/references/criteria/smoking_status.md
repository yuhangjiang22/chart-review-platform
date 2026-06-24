---
field_id: smoking_status
prompt: What is the patient's documented smoking status?
answer_schema:
  enum: ["current", "former", "never", "unknown"]
cardinality: one
group: demographics
---

# Criterion: smoking_status

The patient's documented **tobacco smoking status**:
- `current` — current smoker / active tobacco use.
- `former` — quit / ex-smoker / past tobacco use, not current.
- `never` — never smoked / denies tobacco use.
- `unknown` — status not documented or genuinely unclear.

Use the patient's own status only (not family history). Map "denies tobacco use"
→ `never`; "quit in 2015" → `former`; "1 ppd" / "smokes" → `current`.

**Evidence:** cite the smoking-status span.
