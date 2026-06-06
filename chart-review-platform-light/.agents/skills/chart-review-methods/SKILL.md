---
name: chart-review-methods
description: >
  Drafts an academic-paper Methods section describing a chart-review study from
  a locked guideline plus cohort QA statistics. Use when the user says "write
  the methods section", "draft paper methods", "academic methods text", "methods
  paragraph for the manuscript", "describe the chart review for the paper",
  "STROBE methods", "RECORD methods", or is preparing to publish a study based
  on a locked phenotype protocol. Produces past-tense, third-person markdown
  text (~300-500 words) with the four-paragraph structure (protocol overview,
  criterion structure, reviewer process + reliability, limitations) — extended
  to a five-paragraph structure with a deployment-stage validation paragraph
  when a deployment-kappa.json report is provided. Composes with
  chart-review-calibrate (which produces the calibration kappa) and the
  cohort + sample-validation workflow (which produces the deployment kappa).
metadata:
  author: chart-review-platform
  version: "0.2.0"
---

# Methods Section Drafting

Takes a **locked** chart-review guideline plus cohort QA statistics and
produces a ready-to-paste Methods section for an academic manuscript. The
output follows journal conventions: past tense, third person, ~300-500 words,
with verbatim criterion definition quotes, reported κ values (from QA stats
only, never inferred), and a limitations paragraph. The output is a draft —
the author does final editing for journal voice and consistency with the rest
of the manuscript.

## When to use

- User says "write the methods section", "draft paper methods", "academic methods
  text", "methods paragraph for the manuscript", "describe the chart review for
  the paper", or is preparing to publish a study
- User specifies a reporting checklist style: STROBE, RECORD, or CONSORT
- After calibration is complete and the guideline is locked

Do not use on draft guidelines. The Methods section describes the production
protocol; a draft has not yet been validated. If the user insists on drafting
from an unvalidated guideline, proceed with an explicit caveat in the output.

## Inputs

- **guideline_path**: a locked guideline (`guidelines/<id>/`) — verify that
  `meta.manual_version` does not end in `-draft`
- **qa_stats**: path to a QA stats file (e.g. `cohorts/<id>/qa-stats.json`)
  OR confirmation to call the platform's `computeQAStats` endpoint. Required
  fields: `total_records`, `records_locked`, `records_validated`,
  `by_criterion[<id>].kappa`, `kappa_n_shared`, `kappa_reviewers`,
  `by_criterion[<id>].override_rate`
- **Optional — `deployment_kappa_path`**: path to a deployment-stage report
  (e.g. `cohorts/<cohort_id>/reports/<run_id>/deployment-kappa.json`). When
  provided, the Methods section gains a fifth paragraph reporting
  deployment-stage agent-vs-reviewer agreement on a stratified sample of the
  full deployment cohort. The JSON's `per_criterion[]` carries either
  `metric_type: "kappa"` (with `kappa`, `ci_lower`, `ci_upper`) or
  `metric_type: "exact_match"` (with `rate`, `n_match`, `n_total`); use the
  metric the report records — don't substitute one for the other.
- **Optional**: word count hint (default ~400 words), journal style (STROBE /
  RECORD / CONSORT), audience (clinical journal vs informatics journal —
  affects technical depth of AI-assistance disclosure)

## Procedure

1. **Read the guideline end-to-end:**
   - `<guideline_path>/meta.yaml` for `task_type`, `review_unit`, `time_windows`,
     `final_output`, `overview_prose`, `source_document_priority`
   - `<guideline_path>/criteria/*.yaml` for the rubric structure
   - Categorize criteria: leaf / derived / gated. Note which are primary (drive
     the final output).

2. **Read the QA stats.** Capture: record count (locked + validated), reviewer
   count (from κ pairs), per-primary-criterion κ with n_shared, per-criterion
   override rate, any drift events worth mentioning.

   **If `deployment_kappa_path` was provided**, also read it. The JSON has
   `cohort_id`, `n_validated_patients`, `n_total_sampled`, `overall_kappa`
   with 95% CI, and `per_criterion[]` with mixed metric types (kappa or
   exact_match). The deployment cohort manifest at
   `cohorts/<cohort_id>/manifest.json` gives the cohort size N and any
   `inclusion_criteria_text` for paragraph 4 (block 5 of blueprint §7).

3. **Draft the Methods section** using the four-paragraph structure (or
   five-paragraph structure if `deployment_kappa_path` was provided) —
   see `references/methods-template.md` for sentence templates and fill-in
   guidance per paragraph. Follow the writing conventions in
   `references/journal-conventions.md` (past tense, third person, verbatim
   quotes in double quotes, n_shared alongside κ, AI assistance disclosure).

4. **Add journal-checklist items** if the user specified a style (STROBE,
   RECORD, CONSORT). See `references/methods-template.md` §"Journal-specific
   additions" and `references/journal-conventions.md` for the expected items.

5. **Output.** Return the markdown text. No platform-side write — the user
   pastes into their manuscript. If the user explicitly asks to save, write to
   `manuscripts/<guideline-id>-methods-<ts>.md`.

## Universal references

- See `skills/chart-review/references/reliability-metrics.md` for the κ
  interpretation context (which metric applies to which criterion type).
- See `skills/chart-review/references/lifecycle.md` for the locked-phase
  prerequisite this skill depends on.

## Skill-specific references

- `references/methods-template.md` — four-paragraph structure with word-count
  targets, sentence templates, and fill-in guidance per paragraph; includes
  journal-specific checklist additions (STROBE, RECORD, CONSORT)
- `references/journal-conventions.md` — writing conventions (voice, tense,
  specificity rules, what to omit, κ interpretation language, limitations
  paragraph conventions) with a word-count table by journal type

## Hard rules (with reasons)

- **The guideline must be locked.** Methods text describes the production
  protocol; reporting on a draft would misrepresent what was validated. If
  `meta.manual_version` ends in `-draft`, warn the user and ask for
  confirmation before proceeding.
- **κ values come from qa_stats only — never inferred.** Inferring κ from
  non-quantitative descriptions would produce numbers the authors can't defend;
  if κ is missing for a criterion, omit it rather than guess.
- **Criterion definitions go in verbatim double quotes.** Reviewers were trained
  on the exact wording; paraphrasing would misrepresent what was abstracted.
- **Don't hide a low κ.** If a primary criterion has κ < 0.70, report the actual
  value in Paragraph 3 and add a sentence to Limitations. Omitting a known
  weakness would mislead peer reviewers and readers.
- **Word count is a guideline, not a hard limit.** Don't pad below 250 words
  of real content; don't strip meaningful detail to hit a word count.
  Quality over brevity.

## Troubleshooting

**QA stats missing entirely:** Ask the user to either (a) provide a path to
qa-stats.json, or (b) confirm to call the platform's `computeQAStats` endpoint.
Without stats, the Methods section can't honestly report reliability.

**κ is below 0.70 on a primary criterion:** Report the actual κ. Add a Limitations
sentence: "Criterion [id] showed κ = [value]; disagreements were adjudicated by
a third reviewer for the primary analysis." Don't hide it.

**Guideline still has TODOs in extraction_guidance:** Flag this in your summary
to the user. A locked guideline shouldn't have TODO comments; if it does, the
protocol may not be ready for publication-grade reporting.

**User wants a specific journal style not covered in the template:** Apply the
general four-paragraph structure and note which STROBE/RECORD/CONSORT items
you added. For journal-specific formatting (numbered sections, subheadings,
etc.), note the conventions used and let the author apply house style.
