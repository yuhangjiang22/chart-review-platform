---
field_id: insulin_use
prompt: What is the patient's documented insulin use?
answer_schema:
  enum: [current, historical, never, no_info]
cardinality: one
group: medications
---

# Criterion: insulin_use

## Definition

The patient's documented insulin use — any insulin product (basal, bolus, mixed,
pump/CSII; brand or generic). Drives the classification (step 2: no history of
insulin → T2D).

## Extraction guidance

**Always commit one value** (do not leave blank):

- **`current`** — insulin active/ongoing (current med list, active prescription,
  pump in use).
- **`historical`** — insulin used in the past but not currently.
- **`never`** — the record affirmatively indicates the patient has **no history**
  of insulin. Use only when the medication history is sufficiently complete to
  support that (an explicit "no insulin", or a complete med reconciliation with no
  insulin ever). `never` is what fires the classification's "no insulin → T2D" step.
- **`no_info`** — insulin status cannot be established from the available record
  (incomplete med history). Do NOT use `never` when you simply found no mention.

Read `drugs` (OMOP) for insulin ingredients first, then notes / med
reconciliation. Cite the drug row or the note span.

## Examples

- Active "insulin glargine 20 units nightly" → `current`
- "Was on insulin 2019–2021, stopped" → `historical`
- "No history of insulin therapy" / complete med rec with no insulin → `never`
- Sparse outside records, insulin not addressed → `no_info`
