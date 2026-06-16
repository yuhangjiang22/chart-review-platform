# Methods section template — chart-review-methods

The four-paragraph structure for a chart-review study Methods section.
Target: ~300-500 words. Each paragraph has a word-count target; don't pad,
don't strip below 250 words total.

---

## Paragraph 1: Protocol overview (~80 words)

What was reviewed, what the labels are, what time window. Frame the `task_type`
(e.g., "phenotype validation", "cohort classification"). Reference the final
output's possible values.

**Sentence templates:**
- "We adapted a structured chart-review protocol to validate [phenotype/condition]
  from the electronic health record."
- "The protocol produced a [N]-tier label — [label1] ([definition]), [label2]
  ([definition]), or [label3] ([definition]) — based on data within a
  [time_window] lookback window anchored at [index_event]."
- "Chart review was performed at the level of [review_unit]."

**What to fill in:**
- `task_type` from `meta.task_type`
- Final output labels from the final-output criterion's `answer_schema.enum`
- Time window from `meta.time_windows`
- Index anchor from `meta.index_anchor`
- Review unit from `meta.review_unit`

---

## Paragraph 2: Criterion structure (~120 words)

How many leaf criteria, how many derived, how many gated. Quote 2-3
load-bearing criterion definitions verbatim from `guidance_prose.definition`.
Mention `source_document_priority` if non-trivial.

**Sentence templates:**
- "[N] criteria were structured into [G] groups: [group1] ([n] leaves + [n]
  derived), [group2] ([n] leaves), with [N] summary fields."
- "[Source document type] had source-document priority over [other type], which
  had priority over [third type]."
- "Specific definitions included [criterion_id] ('[verbatim definition from
  guidance_prose.definition]') and [criterion_id] ('[verbatim definition]')."

**What to fill in:**
- Count criteria by type (leaf / derived / gated) from the criteria/*.yaml files
- Identify the most load-bearing definitions (usually the gating criterion and
  the final output criterion)
- Quote definitions verbatim — put them in double quotes

---

## Paragraph 3: Reviewer process and reliability (~120 words)

How many records reviewed, how many reviewers, training. κ values if computed.
Mention AI assistance if reviewers used the chart-review skill.

**Sentence templates:**
- "[N] clinical reviewers independently abstracted [N] records each."
- "Inter-rater reliability (Cohen's κ) was computed on the [N] records shared
  between the reviewers, yielding κ = [value] for [criterion_id], κ = [value]
  for [criterion_id], and κ = [value] for the final [outcome_criterion]."
- "Reviewers used a chart-review agent that proposed answers from the chart;
  reviewers verified each evidence citation and overrode the agent's draft when
  warranted (override rate: [X]% across all criteria)."

**What to fill in:**
- record count from qa_stats.records_locked + records_validated
- reviewer count from qa_stats.kappa_reviewers
- κ values per primary criterion from qa_stats.by_criterion[id].kappa
  (ONLY from qa_stats — never infer)
- override rate from qa_stats

---

## Paragraph 4 (optional): Deployment-stage validation (~140 words)

Include this paragraph **only when** the caller provided
`deployment_kappa_path`. This describes the publishable accuracy of the
locked rubric on a stratified sample drawn from the full deployment cohort —
distinct from the calibration κ in Paragraph 3, which lives on the
calibration cohort. Both numbers belong in a publication; readers care most
about deployment-stage agreement.

**Sentence templates:**
- "We applied the locked rubric (sha [guideline_sha]) to a deployment cohort
  of N=[cohort.patient_ids.length] patients drawn from [cohort source]; a
  stratified random sample of N=[n_total_sampled] patients (stratified by
  [strategy.stratify_by], [strategy.balance] balance, seed [strategy.seed])
  was independently scored by [N] reviewers blinded to the agent's draft
  output."
- "Deployment-stage agent-vs-reviewer agreement was κ = [overall_kappa]
  (95% CI [overall_ci[0]]–[overall_ci[1]]) across the [n_with_kappa]
  categorical criteria; per-criterion values are listed in Table [N]."
- For numeric criteria: "[criterion_id] (numeric): exact-match rate
  [rate*100]% ([n_match]/[n_total])."

**What to fill in:**
- cohort size from cohort manifest patient_ids.length
- sampling strategy from `cohorts/<cohort_id>/sample/selections/<run>.json`'s
  `strategy` block
- overall κ + CI from deployment-kappa.json `overall_kappa` and `overall_ci`
- per-criterion values from `per_criterion[]`; check `metric_type` to choose
  the right phrasing — kappa criteria report κ + CI + n; exact_match
  criteria report rate + n_match/n_total

**Honesty requirements:**
- The deployment-stage κ usually trends LOWER than calibration κ (real-world
  charts have more edge cases than the calibration set). Don't smooth over
  the gap; if it's >0.10, mention it in Limitations.
- If `n_validated_patients < n_total_sampled`, the report is intermediate;
  say so explicitly: "[N] of [N_total_sampled] sampled patients had
  completed validation at the time of analysis."

---

## Paragraph 5: Limitations (~80 words)

Synthetic vs real corpus. Reviewer subjectivity. Lookback window constraints.
EHR coverage. Any criterion with κ < 0.7 should get a sentence here.

**Sentence templates:**
- "Limitations include the lookback window's potential to miss diagnoses
  established outside its range..."
- "Reliance on free-text [note_type] reports whose absence (rather than negative
  findings) we coded as [no_info_value]..."
- "The inherent subjectivity of [criterion_id] classification for [edge_case_scenario]..."
- "Criterion [id] showed κ = [value]; disagreements were adjudicated by a third
  reviewer for the primary analysis." (use only if κ < 0.7 for a primary criterion)

---

## Journal-specific additions

If the user specifies a reporting checklist, add the following items:

**STROBE (observational studies):**
- Data sources section: describe EHR source system, extraction date range
- Case ascertainment: describe how patients entered the denominator
- Missing data handling: describe how `no_info` answers were handled in analysis

**RECORD (routinely collected health data):**
- Linkage methods: describe any data linkage used to build the EHR corpus
- Data cleaning: describe any de-identification or normalization steps

**CONSORT (if applicable, for comparative studies):**
- Blinding: clarify that reviewers were blinded to each other but not to the
  patient record
