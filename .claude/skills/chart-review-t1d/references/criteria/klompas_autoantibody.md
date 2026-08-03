---
field_id: klompas_autoantibody
prompt: Klompas criterion — positive diabetes autoantibody?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: klompas
derivation: 'autoantibody_result == "positive" ? "met" : "not_met"'
---

# Criterion: klompas_autoantibody (computed)

## Definition

Whether a **positive diabetes autoantibody** is documented. **Computed** from
`autoantibody_result` — do not answer directly. `negative`, `borderline`, and
`not_tested` are all `not_met`.
