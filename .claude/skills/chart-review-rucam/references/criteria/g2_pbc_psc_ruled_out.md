---
field_id: g2_pbc_psc_ruled_out
prompt: For Item 5 (Group II), are PBC/PSC ruled out — by workup or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g2_pbc_psc_ruled_out

## Definition

Group II cause 4 of 5 — **primary biliary cholangitis (PBC) / primary sclerosing
cholangitis (PSC)**, window T0 − 365 to T0 + 30 days. `yes` only if **(a)** ruled out
by objective evidence (negative AMA, MRCP without PSC changes) or **(b)** explicitly
excluded by a note. `no` if not assessed, indeterminate, or present. Absence of any
mention in the window is "not assessed" → `no`.

## Extraction guidance

Use `get_conditions` filtered to [-365, +30] and search notes for "primary biliary",
"PBC", "sclerosing cholangitis", "PSC", "AMA", "MRCP" (per
`references/scoring/item-5-exclusion.md`, Group II). Cite the evidence.

**Reuse evidence you already have — AMA is the PBC test; biliary imaging is the PSC
test.** Do NOT require a workup literally labeled "PBC/PSC":
- A **negative AMA** (anti-mitochondrial antibody) rules out PBC — this is usually the
  *same* AMA result you cite for autoimmune hepatitis; reuse it here.
- **Normal biliary imaging** (RUQ ultrasound / MRCP / ERCP showing no ductal dilatation,
  beading, or strictures) rules out PSC.

Commit `yes` when AMA is negative AND biliary imaging is unremarkable (or a note
explicitly excludes PBC/PSC). Reserve `no` for cases where **neither** AMA **nor** biliary
imaging is available in the window (genuinely not assessed) — a tested-negative AMA and a
clean biliary tree are positive rule-out evidence, not "absence of mention."
