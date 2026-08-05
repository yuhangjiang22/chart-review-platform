---
field_id: alt_cause_explains
prompt: For Item 5, does a clear alternative (non-drug) cause sufficiently explain the liver injury?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: alt_cause_explains

## Definition

The Item 5 **−3 judgment** — is there a clear alternative diagnosis that *sufficiently
accounts for* the injury (e.g. shock liver from cardiogenic shock, transaminitis from
sepsis, confirmed acute viral hepatitis, biliary obstruction with ductal dilation)?
The evidence must be sufficient to explain the injury, not merely present. `no` when a
cause is mentioned but not attributed, labs are inconclusive, or only a risk factor is
present.

## Extraction guidance

`yes` only when a clinician attributes the injury to a non-drug cause, or a confirmed
active alternative diagnosis explains it during the injury window. When `yes`, Item 5
is −3 (overrides the ruled-out count). Cite the attributing span.

**Never set `yes` from a bare structured chronic-history flag alone**
(`alcohol_use_disorder=1`, `alcoholic_liver_disease=1`, `cirrhosis_hx=1`, etc.) — a
history flag is the patient's background, not an attribution for *this* episode, and
counts as "only a risk factor is present." Require either an explicit clinician
statement tying the alternative cause to this injury, or objective evidence inside the
injury window (e.g., AST:ALT ≥ 2 at/near T0 **plus** a note confirming active heavy
drinking at that time, not the chronic diagnosis code alone).
