---
field_id: lcn_compensated_cirrhosis
prompt: LCN compensated-cirrhosis phenotype at the reference date (computed proposal - Human-Only final call)
answer_schema:
  enum: [met, not_met]
cardinality: one
group: computed
derivation: 'step1_cirrhosis == "met" AND step2_compensated == "met" ? "met" : "not_met"'
---

# Computed: lcn_compensated_cirrhosis (final output - proposal)

**Computed - do not answer directly.** The phenotype = Step 1 (cirrhosis
established) AND Step 2 (compensated), both read at the reference date — the
end of the chart. This is the machine PROPOSAL; the reviewer confirms or
overrides during VALIDATE. It is NOT the study outcome: the outcome is the
first date on which both steps hold, found by the downstream scanner from the
windowless date leaves. Every input traces to a dated evidence citation and to
the LCN paper's criteria (Tapper et al. 2025, Table 2 + Cirrhosis Severity).
