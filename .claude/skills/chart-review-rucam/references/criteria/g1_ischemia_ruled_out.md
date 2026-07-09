---
field_id: g1_ischemia_ruled_out
prompt: For Item 5 (Group I), is hypotension/shock/ischemic ("shock liver") injury ruled out — by history or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g1_ischemia_ruled_out

## Definition

Group I cause 6 of 6 — **hypotension / shock / ischemic hepatitis ("shock liver")**
within T0 ± 2 weeks. `yes` only if **(a)** ruled out by objective evidence (no
hypotension/shock episode in the window) or **(b)** explicitly excluded by a note.
`no` if not assessed, indeterminate, or present (a documented hypotensive/shock event).

## Extraction guidance

Check structured ischemia/hypotension/shock flags and vitals in the ±2-week window,
plus note text for an explicit exclusion (per `references/scoring/item-5-exclusion.md`,
Group I #6). Cite the evidence.
