---
name: chart-review
description: >
  Reviews a patient's electronic health record against a clinical phenotyping
  rubric (also called a chart-review guideline or abstraction protocol). Use
  whenever the user says "review this chart", "review this patient", "abstract
  this case", "is this lung cancer confirmed", "fill out the review form",
  "does this patient meet the criteria", or asks any question that maps to a
  guideline criterion. Reads notes, pathology reports, imaging, ICD codes,
  and OMOP-style structured data; consults the active phenotype skill's
  criteria, code sets, edge cases, and exemplars; commits answers via the
  chart_review_state MCP tools (set_field_assessment, select_evidence,
  set_summary, find_quote_offsets). Composes with phenotype scope-skills
  (chart-review-<noun>-phenotype) that provide the rubric definition.
metadata:
  author: chart-review-platform
  version: "0.2.0"
---

# Chart Review

The universal chart-review methodology. This is the *reviewer* skill — it works
through a phenotype's criteria one at a time and commits answers with cited
evidence. Other sibling skills handle authoring, calibration, improvement,
cohort feedback, and methods drafting (see Quick Reference below).

## Sibling skills

The platform splits chart-review work across siblings under `.claude/skills/`.
The chart-review skill is the orchestrator + universal methodology; the others
specialize.

| Sibling skill | When it activates |
|---|---|
| `chart-review-author`     | "draft a phenotype", "create chart-review protocol" |
| `chart-review-build`      | "build a guideline with me", interactive drafting |
| `chart-review-calibrate`  | "calibrate this draft", "compute kappa", lock-test eligibility |
| `chart-review-improve`    | "improve guideline", "cluster overrides into proposals" |
| `chart-review-cohort`     | "what's drifting", "cohort feedback", drift triage |
| `chart-review-copilot`    | reviewer's review-time questions during validation |
| `chart-review-methods`    | "draft methods section", "write paper methods" |

Phenotype scope-skills (`chart-review-<noun>-phenotype`, e.g.,
`chart-review-lung-cancer-phenotype`) provide the rubric scope — they define
which criteria, code sets, and edge cases apply to a specific phenotype. They
auto-activate when the user names the phenotype.

## Active phenotype resolution

When the chart-review skill is active, identify the phenotype using:

1. **Explicit user mention** — "review for lung cancer" → `chart-review-lung-cancer-phenotype`
2. **Platform context** — `Active guideline: <task_id>` line in the user prompt
   (provided by the platform in batch mode and via the v2 client's active task)
3. **Patient meta hint** — `corpus/patients/<pid>/meta.json:category` (last resort)

Once the phenotype is known, look up the corresponding skill at
`.claude/skills/chart-review-<task_id>-phenotype/` and consult its
`references/criteria/` directory.

If a phenotype skill cannot be located (legacy / pre-migration phenotypes), fall
back to `guidelines/<task_id>/criteria/*.yaml`.

## Review procedure — two axes

A chart review is shaped by two orthogonal axes. The session's role framing
may set each independently; combinations are valid (search × interpretation).

### Axis 1 — search mode (HOW you find evidence)

Pick the procedure source by what the role framing names. If no search mode
is named, default to `smart-search`.

| Search mode | Procedure source | When |
|---|---|---|
| `smart-search` | `references/smart-search-procedure.md` | default; production single-agent runs; one side of search-recall benchmarks |
| `comprehensive` | `references/comprehensive-procedure.md` | exhaustive read; recall-optimized; gold-standard generation; the other side of search-recall benchmarks |

Both procedures answer every leaf criterion the active phenotype defines.
Both follow the **universal multi-citation discipline** in
`references/evidence-citation.md` — every span the agent identified gets
cited. The two modes differ ONLY in which evidence gets identified, not in
how much of the identified evidence gets cited.

### Axis 2 — interpretation attitude (HOW you read what you find)

Independent of search mode. The role framing's attitude preset (e.g.,
`default`, `skeptical`) governs how to weigh hedged or ambiguous language
once the evidence is in hand. It does NOT alter the procedure or the
citation discipline; it influences only the answer chosen when the chart's
language admits more than one defensible reading.

### Composing the axes

Every (search, interpretation) pair is a valid configuration:
`smart-search × default`, `smart-search × skeptical`, `comprehensive ×
default`, `comprehensive × skeptical`. Pilots use this to produce
disagreement statistics that decompose along the two axes — e.g., if two
agents disagree only when their interpretation differs but their search mode
matches, the disagreement source is interpretation, not retrieval.

## Universal references

- `references/evidence-citation.md` — citation discipline (REQUIRED for every
  `set_field_assessment` call; absence-as-evidence patterns; OMOP-row citations)
- `references/mcp-tools.md` — chart_review_state MCP tools (set_field_assessment,
  find_quote_offsets, select_evidence, set_summary, get_review_state) plus
  common error conditions
- `references/lifecycle.md` — phase definitions (draft → piloted → calibrated →
  locked → deployed) and what triggers transitions
- `references/reliability-metrics.md` — which inter-rater metric to use per
  criterion type (κ for binary/nominal, weighted κ for ordinal, ICC for
  continuous, Jaccard for sets, date-tolerance for dates)
- `references/examples.md` — worked examples on canonical criteria
- `references/smart-search-procedure.md` — keyword/grep-driven review
  procedure (default search mode; what the agent does when no search mode is
  named in the role framing)
- `references/comprehensive-procedure.md` — exhaustive read procedure used
  when role framing selects `comprehensive` search mode

Phenotype scope-skills cross-reference these by relative path (e.g.,
`skills/chart-review/references/evidence-citation.md`).

## Hard rules (with reasons)

- **Read only the active patient's chart and the active phenotype skill's
  references.** Other patients' folders are forbidden — chart-review studies
  are per-patient and cross-contamination would invalidate the data.
- **Don't modify guideline files.** Rubric edits go through `chart-review-author`,
  `chart-review-build`, or `chart-review-improve` — those skills handle
  versioning and SHA-pinning. The chart-review skill is read-only on rubrics.
- **Note evidence must be verbatim.** Always pass offsets from
  `find_quote_offsets` directly through to `set_field_assessment`. Hand-counted
  offsets fail the platform's faithfulness gate.
- **If the chart is silent on a question, answer the most-conservative valid
  enum value (`no_info` or `false`) and cite the chart's coverage as evidence**
  — see `references/evidence-citation.md` §"absence answers". Never fabricate
  answers when the chart is silent.
- **Every criterion in the rubric must have a value before set_review_status:
  complete.** If you cannot determine a criterion's value, set it to
  `not_applicable` (when the criterion is gated and the gate is not satisfied)
  or `no_info` (when relevant evidence is genuinely absent from the chart) with
  a brief rationale. Do not skip — the MCP commit gate will reject the request
  and you will have to redo the work.
