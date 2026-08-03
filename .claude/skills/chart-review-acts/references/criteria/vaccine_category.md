---
field_id: vaccine_category
prompt: What vaccine categories are documented (derived from the vaccine list)?
answer_schema:
  type: array
cardinality: many
group: vaccine
required: false
derivation: 'entity_attr(vaccine_name, Category)'
---

# Criterion: vaccine_category (computed)

## Definition

The set of **vaccine categories** documented in this note, as a standalone
array — one of `Live Vaccine`, `Non-Live Vaccine`, `BCG`, or
`Active Amyloid or Tau Immunization` (the guideline's four categories). This
field is **computed**, not extracted: it is the distinct, sorted set of the
`Category` attribute across the `vaccine_name` entities. The per-vaccine
category still lives on each `vaccine_name` entity; this field surfaces them as
a top-level output to match the guideline's `Vaccine_Category` variable.

The entity-handling sentinels `Not a vaccine` and `Ambiguous` are excluded —
only real guideline categories appear here.

## Extraction guidance

Do not answer this field directly — it is auto-derived from `vaccine_name`'s
`Category` attributes (`entity_attr(vaccine_name, Category)`). To change it, fix
the vaccine entities; this value recomputes. Empty / not present when no
categorized vaccine is documented.

## Examples

- `vaccine_name = [{vaccine: "Influenza", Category: "Non-Live Vaccine"}, {vaccine: "Zoster (Shingrix)", Category: "Non-Live Vaccine"}]` → `["Non-Live Vaccine"]`
- `vaccine_name = [{vaccine: "MMR", Category: "Live Vaccine"}, {vaccine: "Influenza", Category: "Non-Live Vaccine"}]` → `["Live Vaccine", "Non-Live Vaccine"]`
- `vaccine_name = []` (none documented) → (leave unanswered)
