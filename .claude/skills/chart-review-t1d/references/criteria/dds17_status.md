---
field_id: dds17_status
prompt: What is the completion status of the DDS-17 (Diabetes Distress Scale, 17-item)?
answer_schema:
  enum: [present_with_score, present_without_score, mentioned_planned, blank_template, copied_forward, not_present, uncertain]
cardinality: one
group: surveys
---

# Criterion: dds17_status

## Definition

The completion status of the **DDS-17** (Diabetes Distress Scale, 17-item, mean
1–6) for this patient. **Always commit one value.**

## Extraction guidance

| Value | When |
|---|---|
| `present_with_score` | DDS-17 named/identified with a valid mean score (1–6) |
| `present_without_score` | DDS-17 done but no score recorded |
| `mentioned_planned` | Discussed/ordered, not completed |
| `blank_template` | Form shell / default text, no responses |
| `copied_forward` | Prior score repeated with no re-administration |
| `not_present` | No DDS-17 documented after checking notes + structured data |
| `uncertain` | Instrument/version/completion can't be established |

Confirm the **17-item** DDS (distinct from the 28-item T1D-DDS). A generic screening
code (CPT 96127) does NOT by itself identify the DDS-17 — require the instrument
name, a score, item responses, or a verified local form. Cite the row/span.
