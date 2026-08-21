---
field_id: step1_criteria_count
prompt: How many of Step-1 criteria A-E are met? (computed)
answer_schema:
  type: integer
  minimum: 0
  maximum: 5
cardinality: one
group: computed
derivation: 'count_true([crit_a_imaging == "met", crit_b_stiffness == "met", crit_c_varices == "met", crit_d_biomarker == "met", crit_e_biopsy_old == "met"])'
---

# Computed: step1_criteria_count

Count of Step-1 criteria A-E that are `met`. **Computed - do not answer
directly.** Because every criterion leaf is always committed
(`met`/`not_met`), this count always resolves.

Distinct-studies rule (v2 op 4): the ">= 2 of A-E" requirement means two
criteria from DISTINCT studies ("sequential or paired testing of two or more
modalities"). The known overlap risk is one imaging study supplying both A
and C — the crit_c_varices guidance asks the agent to flag that case in its
rationale for reviewer adjudication.
