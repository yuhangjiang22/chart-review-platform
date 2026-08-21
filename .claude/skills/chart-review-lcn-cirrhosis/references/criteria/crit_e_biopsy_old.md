---
field_id: crit_e_biopsy_old
prompt: Criterion E - liver biopsy OLDER than 5 years showing METAVIR 4 or Ishak 5-6?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: step1_criteria
---

# Criterion E: old biopsy (>=5 years before index)

## Definition
A liver biopsy **5 or more years before index** demonstrating **METAVIR 4 or
Ishak 5-6**. Unlike the recent-biopsy rule this is NOT sufficient alone - it
counts as ONE of the >=2 criteria. (LCN Table 2, criterion E.)

## Extraction guidance
**Always commit one value.** Same staging threshold as the recent-biopsy rule;
the only difference is age of the biopsy. A biopsy WITHIN 5 years belongs to
`biopsy_recent_cirrhosis`, not here.

## Examples
- "Liver biopsy 2016: Ishak stage 5" with index 2025 -> `met`
- Only a 2023 biopsy exists (index 2025) -> `not_met` (that one is recent)
