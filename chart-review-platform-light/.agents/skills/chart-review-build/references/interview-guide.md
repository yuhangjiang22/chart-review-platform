# Interview guide — chart-review-build

Detailed rules for the Phase 1 gathering conversation and the phase checklist
that governs when to call `mark_drafted`.

## Question format — exactly this template

Every gathering question uses this format. Do not deviate.

```
<Question, one sentence, <= 20 words>

<Why-it-matters, one sentence on what later decision this affects>

1. **<option-name>** — <one-sentence description / trade-off>
2. **<option-name>** — <one-sentence description / trade-off>
3. **<option-name>** — <one-sentence description / trade-off>

**My recommendation: <option-name>** because <one-sentence reason>.

Pick one or push back.
```

For genuinely open questions (e.g. "name this criterion") where there's no
good multiple-choice form, ask in plain prose with a strong recommendation:

```
What should we call this criterion? I'd default to `received_30d_visit`
(kebab-case, matches the outcome variable). Push back if you prefer something else.
```

### Concrete example — output shape question

```
What shape should the final answer take for each chart?

This decides whether later criteria are framed as evidence (did X happen?)
or as outcome (was the right thing done?). It shapes every criterion.

1. **outcome-first** — single labeled outcome (e.g. `received_30d_visit: yes/no/exception`)
   per chart, with cited evidence. Cleanest for adherence questions.
2. **evidence-first** — structured evidence fields (visit_date, visit_type,
   cardiology_note_present); outcome derived from them.
3. **hybrid** — outcome field plus 2-3 key supporting evidence fields captured alongside.
4. **timeline** — ordered list of relevant events; outcome inferred from the timeline.
5. **narrative** — free-text adjudication summary, no structured outcome.

**My recommendation: outcome-first** because this is a textbook guideline-adherence
question — you want one yes/no per chart, with evidence as the audit trail.

Pick one or push back.
```

## Gathering checklist — the 7 phases

Walk these phases in order. Track them in your head (you don't need to enumerate
them out loud each turn). When phases 1–5 are ALL satisfied, call `mark_drafted`
and proceed to Phase 2.

**Phase progress strip — mandatory:** Call `set_phase_status(phase_name, status)`
at every phase transition so the reviewer's UI shows a live progress strip:
  - When you move INTO a phase (begin asking its question): `set_phase_status(<phase>, "active")`
  - When a phase is settled / locked: `set_phase_status(<phase>, "locked")`
  - Do NOT call `set_phase_status` for phases you haven't reached yet — leave them as implicit pending.
  - Call it in the same turn as your question or your lock confirmation, before or after the prose.

| # | Phase name | What "satisfied" means | MCP call on transition |
|---|---|---|---|
| 1 | `intake` | One-sentence research question is on the record. (Often the reviewer's first message — no question needed.) | `set_phase_status("intake", "active")` on open; `set_phase_status("intake", "locked")` once captured. |
| 2 | `output_shape` | One of {outcome-first, evidence-first, hybrid, timeline, narrative} is locked. **Hard gate** — don't proceed to phase 3 until settled. | `set_phase_status("output_shape", "active")` when asking; `set_phase_status("output_shape", "locked")` when confirmed. |
| 3 | `population` | Denominator (who's in scope), index event (the anchor), and at least one time window are settled. | `set_phase_status("population", "active")` / `"locked"` as above. |
| 4 | `criteria` | At least 1 criterion has a prompt + answer schema settled. (Stop at 1–5 criteria for v0 — reviewer expands later.) | `set_phase_status("criteria", "active")` / `"locked"` as above. |
| 5 | `evidence` | For each settled criterion, you know where to look (note types, structured fields, codes if any), AND you have at least one satisfying example, one non-satisfying example, and one boundary or failure-mode case. Use the four-axis prose split (`satisfying_examples` / `non_satisfying_examples` / `boundary_examples` / `failure_modes` under `guidance_prose`) — see yaml-templates.md. Eliciting these four axes separately catches ambiguity faster than a single mixed examples blob. | `set_phase_status("evidence", "active")` / `"locked"` as above. |
| 6 | `edge_cases` | Optional — only if reviewer raises them or you observed contradictions in samples. NOT REQUIRED to call `mark_drafted`. | `set_phase_status("edge_cases", "active")` / `"locked"` only if this phase is visited. |
| 7 | `codes` | Optional — only if reviewer has supplied codes or keywords. NOT REQUIRED. | `set_phase_status("codes", "active")` / `"locked"` only if this phase is visited. |

**The stop signal**: phases 1–5 each have at least one settled answer. Don't
keep asking. Call `mark_drafted`.

If the reviewer pivots ("actually let me define eligibility first"), accept the
pivot — track in your head that you still owe questions about the skipped
phase, and pick it up after the pivot completes.

## Push-back triggers — what to never silently accept

The atomic-criteria doctrine
(`skills/chart-review/references/atomic-criteria.md`) is load-bearing. When
the reviewer proposes a criterion shape that violates atomicity, push back
conversationally before drafting; do not silently accept and move on.
SKILL.md lists the hard rules; this section is the operational guidance.

### Compound criteria

Detect: prompts with "and" / "or" / "if X then Y" / "X unless Y."
Push back per SKILL.md: name the two atomic criteria, offer the combination
as a derivation. See atomic-criteria.md §A.

### Outcome + reason in one enum

Detect: any enum where some values describe **outcome** (met/not_met,
done/not_done, accepted/declined) AND others describe **reason**
(refused, contraindicated, true_gap, pending, outside_records, undocumented,
unknown — or `no_info` when it implicitly means "not applicable").

Worked push-back:

```
Reviewer: "Let's do `pathology_step` with values met / not_met /
refused / contraindicated / true_gap."

You: "I'd split that into two criteria. The first axis is outcome —
`pathology_step_met` with met / not_met. The second axis is reason —
`pathology_step_not_met_reason` with refused_by_patient /
contraindicated / undocumented / true_gap, gated on
`pathology_step_met == 'not_met'`. Reason: a single enum that mixes
outcome and reason can't be reviewed coherently — two reviewers
agreeing 'not_met' might pick different reason values when both apply
(e.g. refused AND contraindicated). Splitting lets per-criterion κ
measure each axis cleanly. Want me to use the split? (Recommended.)"

If reviewer insists on one enum:
"I'll still split — atomic-criteria.md §G rejects compound enums
because κ on a compound axis is incoherent. If you want a single
rolled-up label for cohort tables, I'll add it as a derivation that
combines the two axes — that gives you the unified view AND keeps the
two κ measurements separate. OK?"
```

The split is a hard rule, not negotiable. The cohort-analytics value
proposition (see atomic-criteria.md §G) means the split pays off the
moment the reviewer sees their first per-reason cohort table.

### Phase 4.5 — Wiring derivations

When the user proposes a criterion that's derived from others (the "final
output" or any rollup), ask for the combining rule explicitly:

> "How should `<field_id>` be computed from the leaves? For example: 'if
> pathology_present == yes → confirmed; else if imaging + clinical → probable;
> else absent.'"

Convert the answer to a `derivation` block:

```yaml
derivation:
  kind: expression
  expr: |
    if pathology_present == "yes" then "confirmed"
    else if imaging_suspicious == "yes" and clinical_mention == "yes" then "probable"
    else "absent"
```

After writing the derivation, propose 3–4 boundary truth-table rows:
at-threshold, just-below, just-above, and an any-`null` or all-negative
default. Ask the reviewer to confirm the expected values, then emit a
`derivation_truth_table` array on the same criterion frontmatter:

```yaml
derivation_truth_table:
  - label: pathology positive
    inputs:
      pathology_present: "yes"
      imaging_suspicious: "no"
      clinical_mention: "no"
    expected: "confirmed"
  - label: imaging + clinical
    inputs:
      pathology_present: "no"
      imaging_suspicious: "yes"
      clinical_mention: "yes"
    expected: "probable"
  - label: imaging alone
    inputs:
      pathology_present: "no"
      imaging_suspicious: "yes"
      clinical_mention: "no"
    expected: "absent"
  - label: nothing
    inputs:
      pathology_present: "no"
      imaging_suspicious: "no"
      clinical_mention: "no"
    expected: "absent"
```

The validator runs each row through `evaluate(derivation.expr, inputs)`
and emits `derivation_truth_table_mismatch` if the result differs from
`expected`. If the reviewer declines to write the table, leave it off —
the validator emits a `derivation_no_truth_table` warning (not an error).

Do NOT skip this step — describing the combining rule only in extraction
guidance prose causes the loader to classify the criterion as a leaf and
the agent to answer it directly, which can contradict the rule.

If the user can't articulate a clean rule, that's a strong signal the
decomposition is wrong; offer to revisit Phase 4 atomicity.

### Phase 4.6 — Per-criterion time windows

For each leaf criterion, decide whether it needs a `time_window` reference
in its frontmatter. The decision rule is:

- **Needs a time_window** when the criterion asks about something that
  happened in a window of time relative to the index date — chronic
  conditions, prior events, exposure histories, lab abnormalities.
  Examples: "documented heart failure (lookback)", "prior stroke",
  "ALT peak after drug stop".
- **Does NOT need a time_window** when the criterion asks about a
  point-in-time attribute that is invariant or evaluated only at the
  index date. Examples: patient age, biological sex, current admission
  diagnosis, the value of the index encounter's ECG.

If you find yourself wanting to say "no time window applies" for a
chronic condition, that's a signal you haven't decided what counts as
"present" — go back and pick a window. The default lookback for chronic
conditions in adult chart review is 5–10 years; for acute/episodic
exposures the window is event-specific (24-month for AFib history,
30-day pre and 180-day post for drug exposure, etc.).

Do NOT add a `time_window` to every criterion just to be safe — the
unused window confuses downstream readers about what the criterion
actually scopes.

The validator runs a heuristic over each criterion's `prompt` field
plus the content of its `## Definition` and `## Extraction guidance`
sections (Examples / Boundary / Failure-modes / other sections are
excluded so situational prose doesn't trigger spurious warnings):
"at index" / "currently" / "now" + a `time_window` set → warning
(`time_window_likely_unneeded`); "history of" / "ever" / "prior" without a
`time_window` → warning (`time_window_likely_missing`). If the heuristic
misfires for a legitimate reason (e.g. a derived rollup whose window
is owned by a leaf, a drug-class attribute that has no patient-relative
window, or a phrase that legitimately appears in Definition prose),
set `time_window_check: skip` on the criterion frontmatter with an
inline comment documenting the rationale. Warnings do not block
validation; they surface in pre-flight so the reviewer can decide.

## Worked recipe — guideline concordance rubrics

Use this recipe when the reviewer's research question is "did this
patient receive guideline-concordant / -adherent / -consistent care?"
(NCCN, AHA/ACC, ADA, CMS quality measures, USPSTF, internal
institutional protocols). Concordance is a common-enough output shape
that authors who skip the recipe almost always end up with a non-atomic,
prose-bundled rubric. The recipe is six layers; build them in this order
during Phase 4.

The worked example below is NCCN NSCLC pre-treatment workup
concordance. The structure transfers directly to other concordance
guidelines.

### Layer 1 — anchor leaf for the index event

Concordance is always assessed *relative to* an event — first systemic
therapy, surgery date, diagnosis date, the qualifying encounter for a
quality measure. Pin one anchor leaf first; every per-step "before X"
comparison references it.

```yaml
id: first_systemic_therapy_date
answer_schema: { type: date, nullable: true }
extraction_guidance: >
  First administration date of any cytotoxic, targeted, or
  immunotherapy regimen for this episode. Null if no therapy initiated.
```

If the anchor is null, the final criterion returns `not_applicable` —
surface this short-circuit in Layer 6.

### Layer 2 — step evidence leaves

Each guideline-required step gets a leaf capturing the date or sentinel
value of that step. Don't bundle multiple steps into one leaf even if
the prose feels natural. If a step has multiple acceptable modalities
(MRI vs CT, biopsy vs cytology), make each a separate leaf and combine
them in the Layer 4 derivation:

```yaml
id: pathology_date           # date of pathology report establishing diagnosis
id: imaging_staging_date     # date of CT C/A/P or PET-CT
id: brain_mri_date           # date or null
id: brain_ct_date            # date or null; either modality counts
id: molecular_test_ordered_date
id: molecular_results_documented   # boolean
```

### Layer 3 — applicability gate helpers

Most guideline steps are conditional. Factor each gate condition into
its own derived helper criterion per atomic-criteria.md "Applicability
patterns" Pattern 2:

```yaml
id: brain_imaging_required
derivation: clinical_stage in ['II', 'III', 'IV']

id: molecular_required
derivation: histology_subtype == 'non_squamous'

id: pdl1_required
derivation: io_therapy_planned == true
```

When the guideline rule changes (e.g. NCCN extends an indication), one
helper updates instead of every downstream concordance derivation that
would otherwise have hard-coded the rule.

### Layer 4 — per-step concordance derivations

For each step, a derived enum `[met, not_met, not_applicable]` that
combines date comparison with the applicability gate:

```yaml
id: brain_imaging_step_met
answer_schema: { enum: [met, not_met, not_applicable] }
derivation: |
  first_systemic_therapy_date == null ? 'not_applicable' :
  brain_imaging_required == false ? 'not_applicable' :
  (brain_mri_date != null AND brain_mri_date <= first_systemic_therapy_date)
    OR (brain_ct_date != null AND brain_ct_date <= first_systemic_therapy_date)
    ? 'met' : 'not_met'
```

This uses only date `<=` comparison and boolean OR — no engine extension
beyond what's in the base dialect.

### Layer 5 — `count_true` rollups

Aggregate step concordances using the lift-A `count_true` builtin, which
skips null operands so gated-out steps don't inflate either count:

```yaml
id: workup_steps_required
derivation: |
  count_true([
    true,                     # always-required step (e.g. pathology)
    true,                     # always-required step (e.g. imaging staging)
    brain_imaging_required,
    molecular_required,
    pdl1_required
  ])

id: workup_steps_completed
derivation: |
  count_true([
    pathology_step_met == 'met',
    imaging_staging_step_met == 'met',
    brain_imaging_step_met == 'met',
    molecular_step_met == 'met',
    pdl1_step_met == 'met'
  ])
```

### Layer 6 — final concordance category

```yaml
id: nccn_workup_concordant
answer_schema:
  enum: [concordant, appropriate_deviation, partial, non_concordant, not_applicable]
is_final_output: true
derivation: |
  first_systemic_therapy_date == null ? 'not_applicable' :
  workup_steps_completed == workup_steps_required ? 'concordant' :
  workup_unmet_steps_with_justified_reason == workup_unmet_steps_total ? 'appropriate_deviation' :
  workup_steps_completed >= 2 ? 'partial' :
  'non_concordant'
```

`appropriate_deviation` separates clinical judgment (refusal,
contraindication, step done at outside facility) from quality failure
— required for defensible cohort tables. This depends on having
**reason axes** for each unmet step per atomic-criteria.md §G and the
"Push-back triggers" section above: each `step_not_met_reason` criterion
is a sibling leaf gated on `step_met == 'not_met'`, and the
`workup_unmet_steps_with_justified_reason` aggregator (another
`count_true` over reasons-in-justified-set) drives the
appropriate-deviation arm.

### Why this layered shape

- **Per-step κ.** Each Layer-4 derivation is auditable independently — disagreements localize to "which step" and "which gate," not to the rolled-up concordance number.
- **Cohort tables are direct.** Every meaningful slice ("32% partial; of those, 70% missed only PD-L1") falls out of Layer-4 leaves with no extra work.
- **Guideline updates are local.** When NCCN extends brain MRI to stage IB high-risk, only `brain_imaging_required` (Layer 3) changes; carry-forward preserves all extraction state.
- **Engine-native.** Uses only the lift-A builtins (`count_true`) and the base operators (date `<=`, boolean AND/OR, ternary, `is_applicable_when`). No engine work needed beyond what's already shipped.

### Common authoring traps for concordance rubrics

- **Bundling step outcome + reason into one enum.** See atomic-criteria.md §G and "Push-back triggers" above. Always split outcome leaf + reason leaf.
- **Folding the applicability gate into prose.** `extraction_guidance: "Skip if not stage II+"` instead of `is_applicable_when: brain_imaging_required == true`. See atomic-criteria.md §E.
- **Conflating "before X" with "within N days before X".** The first is just date `<=`; the second needs `days_between` (lift A) and a freshness threshold. Default to `<=` in v0; introduce freshness windows only when the specific guideline mandates one (it usually doesn't).
- **No explicit anchor leaf.** Authors sometimes try to compare each step against an implicit "current date" or a derived event without a leaf. Always make the anchor a real leaf so the rubric can return `not_applicable` cleanly when the anchor is null.
- **One mega-criterion that bundles all steps.** "Did the patient get the full NCCN workup?" — single yes/no/partial enum with prose listing all steps. This is the spec-disposition rejected pattern (composite blocks); split per Layer 2–4.
