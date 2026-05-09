# Clustering heuristics — chart-review-improve

How to detect disagreement patterns from override records and decide what
kind of proposal to write.

## Step 1: Build the disagreement table

For each override in the review records, capture:

```
patient_id | criterion | agent_answer | reviewer_answer | edit_reason | evidence_diff
```

`edit_reason` codes (from the platform's override form):
- `missed_evidence` — agent overlooked a passage that was present
- `misinterpreted` — agent read the passage incorrectly
- `wrong_rule` — agent applied the wrong rubric rule
- `criterion_ambiguous` — reviewer felt the criterion's guidance was unclear
- `other` — catch-all

`evidence_diff` — the evidence the reviewer cited vs what the agent cited.
Look for: recurring quotes, recurring codes, recurring structural findings.

## Step 2: Cluster by signal type

Run through these heuristics in order. A single disagreement can trigger
more than one cluster type; if so, write one proposal per change_kind.

### Signal: same criterion overridden 3+ times

**Interpretation:** criterion-level issue — ambiguous prose, missing edge case,
wrong gate.

**Sub-signals:**
- All overrides share the same `edit_reason=misinterpreted` → `guidance_prose_revise`
- All overrides share the same `edit_reason=wrong_rule` → check if an edge case
  or code set addition would fix it
- Mixed edit_reasons → likely `guidance_prose_revise` with clarification of the
  ambiguous cases

**Minimum:** 3 motivating patients. Below 3, flag as inconclusive.

### Signal: reviewers consistently cite a term the agent didn't search

**Interpretation:** keyword set gap.

**Heuristic:** across 3+ overrides, the reviewer_evidence includes a recurring
phrase or abbreviation that isn't in any keyword_set for the criterion.

**Proposal:** `keyword_set_add` listing the recurring terms.

### Signal: reviewers consistently cite a code outside the agent's lookup

**Interpretation:** code set gap.

**Heuristic:** across 3+ overrides, reviewer_evidence includes a recurring
code (ICD, LOINC, etc.) that isn't in any code_set bound to the criterion.

**Proposal:** `code_set_add` or `code_set_revise` with the missing codes.
If the codes being cited are history/personal-history variants (e.g. Z85.*),
the fix is usually to add them to the `excludes:` list.

### Signal: a specific clinical scenario recurs in disagreements

**Interpretation:** edge case not covered by the rubric.

**Heuristic:** same clinical entity (e.g. "carcinoid", "Z85.118 in lookback")
appears in the evidence of 3+ overrides, each producing the same wrong answer.

**Proposal:** `edge_case_add` naming the pattern, failure mode, and
correct answer hint.

### Signal: gate disagreements (one reviewer marks not_applicable, another doesn't)

**Interpretation:** the upstream gating criterion's prose is ambiguous.

**Heuristic:** for a gated criterion, 3+ patients have one reviewer marking
`not_applicable` while another gives a substantive answer.

**Proposal:** `guidance_prose_revise` on the upstream criterion, not the
gated one. Alternatively `gate_revise` if the is_applicable_when expression
itself is wrong.

### Signal: final derivation produces wrong label

**Interpretation:** derivation expression has a bug or missing case.

**Heuristic:** the correct leaf-criterion answers are in the records, but the
derived final output is wrong. Reviewer overrides are only on the derived field.

**Proposal:** `derivation_revise` on the derived criterion.

## Step 3: Sanity-check each proposal

Before writing:
1. Mentally re-run the agent on each motivating patient with the proposed
   change applied. Would the agent now get the right answer? If 1+ would still
   fail, the proposal isn't right — revise or break it into smaller ones.
2. Is the proposal scoped narrowly? A proposal that says "rewrite all guidance"
   is too broad — break it into per-criterion proposals.
3. Does the proposal contradict the guideline's `meta.overview_prose` intent?
   If so, surface the conflict in the summary instead of proposing a small edit.

## Change kind selection summary

| Root cause | change_kind |
|---|---|
| Agent didn't search the right terms | `keyword_set_add` |
| Agent missed a code family | `code_set_add` |
| Agent counted a history-only code | `code_set_revise` (excludes) |
| Specific clinical scenario not addressed | `edge_case_add` |
| Prose is ambiguous across multiple patients | `guidance_prose_revise` |
| Gate fires/doesn't-fire incorrectly | `gate_revise` |
| Derived label wrong despite correct leaves | `derivation_revise` |
| A hard case would benefit from a walkthrough | `exemplar_add` |
