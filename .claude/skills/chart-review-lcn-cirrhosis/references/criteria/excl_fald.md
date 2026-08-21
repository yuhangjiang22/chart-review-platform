---
field_id: excl_fald
prompt: Is Fontan-associated liver disease (FALD) documented?
answer_schema:
  enum: [yes, no]
cardinality: one
group: exclusions
---

# Exclusion: Fontan-associated liver disease

## Definition
**Known history of Fontan procedure-associated liver disease (FALD)** excludes
the patient from Step 1.

## Extraction guidance
**Always commit one value.** Look for Fontan palliation history plus liver
disease attribution ("FALD", "Fontan-associated liver disease").

## Examples
- "s/p Fontan; FALD with congestive fibrosis" -> `yes`
- No Fontan history anywhere -> `no`
