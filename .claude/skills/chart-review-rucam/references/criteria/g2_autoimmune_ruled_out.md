---
field_id: g2_autoimmune_ruled_out
prompt: For Item 5 (Group II), is autoimmune hepatitis ruled out — by serology/biopsy or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g2_autoimmune_ruled_out

## Definition

Group II cause 1 of 5 — **autoimmune hepatitis**, window T0 − 365 to T0 + 30 days.
`yes` only if **(a)** ruled out by objective testing (negative ANA / SMA / IgG, or
a biopsy not consistent with AIH) or **(b)** explicitly excluded by a note. `no` if
not assessed, indeterminate, or present.

## Extraction guidance

Check `get_serology` for ANA / SMA / IgG (most informative near T0), any liver-biopsy
or hepatology-consult notes, plus explicit note exclusions (per
`references/scoring/item-5-exclusion.md`, Group II). Cite the evidence.

**A documented-negative result rules AIH out — don't require an "AIH excluded" note.**
Negative **ANA / SMA / IgG** (or a hepatology assessment / biopsy not consistent with
AIH) = ruled out → `yes`, even when drawn as part of a broad panel. Reserve `no` only
when none of ANA/SMA/IgG/biopsy is available in the window (genuinely not assessed) —
not for the mere absence of a cause-labeled exclusion.
