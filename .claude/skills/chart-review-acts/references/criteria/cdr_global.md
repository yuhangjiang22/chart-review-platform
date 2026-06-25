---
field_id: cdr_global
prompt: What is the documented global Clinical Dementia Rating (CDR)?
answer_schema:
  enum: ["0", "0.5", "1", "2", "3"]
cardinality: one
group: staging
---

# Criterion: cdr_global

## Definition

The documented **global Clinical Dementia Rating (CDR)** for this patient — the
single summary stage of the CDR staging instrument, distinct from the CDR
Sum-of-Boxes. One of five values: `0` (no dementia / normal), `0.5` (questionable
dementia / very mild), `1` (mild dementia), `2` (moderate dementia), `3` (severe
dementia).

## Extraction guidance

Record the documented global CDR value exactly as stated (e.g. "CDR 0.5" → `0.5`,
"global CDR 2" → `2`). Do NOT convert from a different scale — in particular, do
NOT compute the global CDR from the CDR Sum-of-Boxes (e.g. if only "CDR-SB 4" is
documented, leave this null, because the global CDR is not the same number). If no
global CDR stage is documented, leave null.

**Evidence:** cite the CDR span.

## Examples

- "CDR 0" / "global CDR 0" → `0` (none)
- "CDR 0.5" / "questionable dementia, CDR 0.5" → `0.5` (questionable / very mild)
- "CDR 1" / "mild dementia (CDR 1)" → `1` (mild)
- "global CDR 2" → `2` (moderate)
- "CDR 3, severe dementia" → `3` (severe)
- "CDR-SB 4" with no global CDR stated → null (do NOT convert Sum-of-Boxes)
