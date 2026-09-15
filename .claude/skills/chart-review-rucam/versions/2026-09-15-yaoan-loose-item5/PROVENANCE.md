# RUCAM scoring rules — Yao An, 2026-09-15 ("loose item 5")

**This is an archive, not the active rubric.** The live skill is the parent
directory (`.claude/skills/chart-review-rucam/`). Nothing here is loaded at
runtime. It is checked in so that results produced against these rules can be
traced to the exact text that produced them.

## Where it came from

Distributed by Yao An on 2026-09-15 as `skills_loose_item5.zip`, alongside
`RUCAM_Annotator_Guide_All_Types_v8.docx`, with the instruction to revise the
pipeline against it and the human-reviewed results in
`/N/project/ADP01/RDRP-6490-YaoAn/RUCAM_Reassign/Annotation_result/loose_item_5/v5_validation_90/`.
Stated target: >= 90% performance on every item.

## How it relates to the live skill

The two are the same rubric on two branches, not an old copy and a new one.
`item-8-attribution` is byte-identical; the other items share roughly half
their lines. **Neither branch is a superset of the other** — each has content
the other lacks.

### What only this version has

- **Finer clinical rules.** Item 7 is the clearest case: it derives
  re-exposure episodes from the drug-episode record rather than trusting a
  single flag, states that a patient may have **several** re-exposures and
  each must be judged independently, and defines `D_stop_prev` /
  `D_stop_rechallenge` to keep the stop dates straight across them. Items
  1-4 and 6 carry similar refinements.
- **Heavier tool use.** Both versions call the same eight tools; this one
  calls them more often — `get_lab_extremum` 9 times vs 3,
  `get_lft_series` 4 vs 2, `get_drug_episodes` 4 vs 3.

### What only the live skill has

- `score_item5_exclusion`, which seeds each competing cause in item 5 from
  structured data so that a "ruled out" flag has to be justified against it,
  and `compute_r_ratio`. Both are RUCAM-specific tools added on the platform
  side; this version predates or omits them.
- The platform derivation convention — commit components, let the platform
  apply the +3/+1/-2/0 arithmetic — which this version has no need for.
- `meta.yaml` and `references/criteria/`. This package is scoring items and
  SKILL.md only, so it cannot be loaded as a skill as-is.

### The one scoring-policy change

Item 5 inverts the unknown-cause rule. Live: "not assessed / unknown — no
test, no explicit note exclusion; *cannot be counted as ruled out*". Here:
"*absence of any evidence counts as ruled out*". This raises item-5 scores
and therefore total RUCAM scores. Deliberate, per the `loose_item_5` name —
but it is a change of scoring policy, not an edit, and it is the only one in
the package. Everything else is refinement or platform glue.

## Open question

The evaluation directory is named `Validation_Adjudication.xlsx`. A file of
that name was previously established to be agent-drafted with human review
comments, NOT an independent human gold standard (the independent gold was
`RUCAM_Annotation_First_2_Yaoan.xlsx`). If the same holds here, performance
measured against it will read high. Worth confirming with Yao An before the
90% figure is quoted anywhere.

## If these branches are merged later

The merge is not a file copy in either direction. The clinical refinements
here and the tool anchoring in the live skill are independent and both worth
keeping; the item-5 policy is the only place where a choice has to be made,
and it is a methodological decision rather than an editorial one.
