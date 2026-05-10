---
name: chart-review-build
description: >
  Builds a chart-review guideline interactively, interviewing the reviewer
  in plain conversational text then drafting the guideline package once enough
  is known. Use when the user says "build a guideline with me", "help me design
  a chart review protocol", "I want to draft this iteratively", "walk me through
  creating a rubric", or starts the Studio Authoring Builder flow. Subsumes
  chart-review-author for interactive use: produces the same
  .claude/skills/chart-review-<task-id>/ package but step-by-step through conversation.
  Composes with chart-review-calibrate (validate the draft) and
  chart-review-improve (iterate after calibration).
metadata:
  author: chart-review-platform
  version: "0.2.0"
---

# Chart Review Guideline Builder

Interactive two-phase workflow: a structured conversation to gather the
protocol shape (Phase 1 — Gathering), followed by writing the YAML guideline
files once enough is known (Phase 2 — Drafting). Produces the same
`.claude/skills/chart-review-<task-id>/` package as `chart-review-author`, but
step-by-step through conversation rather than in one batch.

## When to use

- User says "build a guideline with me", "help me design a chart review
  protocol", "I want to draft this iteratively", or "walk me through
  creating a rubric"
- User is in the Studio Authoring Builder tab
- User wants to make decisions incrementally with recommendations and
  trade-off explanations rather than hand over all materials at once

For batch authoring (user has all materials and wants a fast draft), prefer
`chart-review-author` instead.

## Phase 1 — Gathering

Plain-text conversation with the reviewer. One question per turn. Present
numbered multiple-choice options with a recommendation and the one-sentence
reason it affects later decisions. Read any available references or samples
before asking — ground recommendations in what you find, not general advice.

**See `references/interview-guide.md` for:**
- Exact question format template (required — never deviate)
- The 7-phase gathering checklist and "satisfied" conditions
- The stop signal: when phases 1-5 are all satisfied, call `mark_drafted`

**Core principles:**
- One question per turn. Never ask two things at once.
- Multiple choice when possible. Most protocol decisions have standard options.
- Always recommend. State your recommended answer in bold with a reason
  BEFORE asking the reviewer to pick.
- Output shape first — pin output_shape BEFORE asking about criteria.
  This is a hard gate; it reframes every later question.
- Stop gathering on time. When phases 1-5 are satisfied, don't keep digging.
  Call `mark_drafted` and write the files.

## Phase 2 — Drafting

After `mark_drafted()`, write guideline files using the `Write` tool.
See `references/file-templates.md` for full templates for each file type.

Write these files, populating them from Phase 1 answers. Output goes to
**`.claude/skills/chart-review-<task-id>/`** — all chart-review skills (draft
and locked) live at this canonical path. Draft maturity is signaled by
`status: draft` in `meta.yaml`, **not** by directory location. The legacy
`.claude/skills/drafts/chart-review-<id>/` and `guidelines/drafts/<id>/`
locations are no longer read by the loader; writes there are invisible.

1. `.claude/skills/chart-review-<task-id>/SKILL.md` (skill stub)
2. `.claude/skills/chart-review-<task-id>/meta.yaml` (include `status: draft`
   — the loader returns drafts with their status, and UI gates LOCK and
   other actions on the flag)
3. `.claude/skills/chart-review-<task-id>/references/criteria/<field_id>.md`
   — **one markdown file per atomic criterion**, with YAML frontmatter +
   body sections (## Definition, ## Extraction guidance, ## Examples,
   ## Failure modes). NOT pure YAML, NOT a multi-field blob with nested
   `fields[]`. One field, one file.
4. `.claude/skills/chart-review-<task-id>/references/code_sets/<id>.yaml`
   (only if reviewer supplied codes)
5. `.claude/skills/chart-review-<task-id>/references/keyword_sets/<id>.yaml`
   (only if reviewer supplied keywords)
6. `.claude/skills/chart-review-<task-id>/references/edge_cases/<id>.yaml`
   (only if reviewer flagged edge cases — one file per edge case)

**One Write per file.** Don't Write meta.yaml then re-Write it with a tweak;
write it once with full content. After the first set of Writes, keep prose to
one sentence — the reviewer can see the document panel.

After the initial Write, respond to reviewer follow-ups (field edits, additions,
corrections) by Reading the affected file and Editing it precisely.

### Validation gate

After writing all files (`meta.yaml` and `references/criteria/*.md`),
call the `validate_package` MCP tool
(`mcp__chart_review_guideline_builder__validate_package`) with the draft path.
If `ok` is false, do NOT declare "Done" — read each diagnostic in the
returned `diagnostics` array, fix the file at `diagnostic.path` per
`diagnostic.message`, and re-run validation. Iterate until `ok: true`.

A run with diagnostics is not a successful build; it's a half-finished
one. The user sees a "Done" message and assumes the package is loadable,
then hits ENOENT or a blank Studio page two clicks later.

## Reviewer interaction in Phase 2

The reviewer can:
- Type a follow-up ("tighten the time window to 14 days") — Read the file,
  Edit it, confirm briefly.
- Edit a YAML file directly — acknowledge the change in one sentence, continue.
- Ask to "add a code set" — Write the new file.

## Universal references

- See `skills/chart-review/references/atomic-criteria.md` for the atomicity
  definition + seven-item authoring checklist + common violations and how to
  split them. **Required reading before drafting any Criterion.** Apply the
  pragmatic test ("would two reviewers giving the same answer mean they agree
  on the same thing?") at every Criterion you propose to the user.
- See `skills/chart-review/references/lifecycle.md` for the draft → locked
  pipeline this skill feeds into.

## Skill-specific references

- `references/interview-guide.md` — required question format template,
  the 7-phase gathering checklist with "satisfied" conditions, push-back
  triggers (compound criteria, outcome+reason enums), and a worked
  layered recipe for guideline-concordance rubrics (use whenever the
  research question mentions concordance / adherence / NCCN / AHA / ADA /
  CMS measures / USPSTF or names another clinical guideline)
- `references/file-templates.md` — full templates for SKILL.md, meta.yaml,
  the per-criterion .md files (frontmatter + body sections), code_sets,
  keyword_sets, and edge_cases. **Required reading before any Write.**
- `references/examples.md` — two worked walkthroughs (interactive from scratch;
  handling a user YAML edit during Phase 2)

## Hard rules (with reasons)

- **Every Criterion must be atomic** per the seven-item checklist in
  `skills/chart-review/references/atomic-criteria.md`. When the user proposes a
  compound Criterion ("does the patient have X and Y?", "is it A unless B?"),
  push back conversationally: surface the split, name the two atomic Criteria,
  and offer to express the combination as a derivation. Do not silently accept
  a non-atomic Criterion — it breaks per-criterion κ, criterion-level rerun,
  and adjudication granularity downstream.
- **Outcome + reason must be split.** When a proposed enum bundles outcome
  values with reason values (e.g. `[met, not_met, refused, contraindicated, true_gap]`),
  surface the split: outcome is one criterion (`[met, not_met]`); reason is a
  sibling criterion gated on `is_applicable_when: <outcome> == 'not_met'`.
  Reason-shaped enum values to detect: `refused`, `declined`, `contraindicated`,
  `pending`, `outside_records`, `undocumented`, `true_gap`, `unknown`. See
  `skills/chart-review/references/atomic-criteria.md` §G and the worked
  push-back dialogue in `references/interview-guide.md`. Do not silently
  accept a compound enum even if the reviewer insists — capture their
  intuition as a derivation if they want a single rolled-up label.
- **Output goes ONLY under `.claude/skills/chart-review-<task-id>/`.** All
  chart-review skills (draft and locked) live at this canonical path; draft
  maturity is signaled by `status: draft` in `meta.yaml`. Always include
  `status: draft` for new drafts. Locking is a status flip
  (`status: locked`), not a directory rename — governed by
  `chart-review-calibrate`. The legacy `.claude/skills/drafts/chart-review-<id>/`
  and `guidelines/drafts/<task-id>/` locations are dead and NOT read by the
  reviewer; writing there produces invisible artifacts.
- **Per-criterion files MUST be markdown (.md) with YAML frontmatter,
  not pure YAML.** The reviewer's loader walks
  `references/criteria/*.md`, parses frontmatter via the `---` delimiters,
  and reads the body for prose sections. A `.yaml` file at the same path
  is silently ignored. See `references/file-templates.md` for the exact
  shape.
- **One criterion = one file = one atomic field.** Never write a single
  file that bundles multiple sub-fields under a `fields[]` array (the
  form-builder shape). Each atomic field gets its own markdown file with
  its own `field_id`, `prompt`, and `answer_schema` in frontmatter. If
  the reviewer describes a multi-part question, split it into separate
  atomic criteria per `skills/chart-review/references/atomic-criteria.md`.
- **Never invent ICD/LOINC/SNOMED codes.** If the reviewer hasn't supplied
  them, add an entry to the criterion's `open_questions:` frontmatter array
  (e.g. `- "Confirm ICD-10 codes for X"`). Incorrect codes silently bias
  downstream agent reviews, and `# TODO` markers in body prose ship as
  authoritative content.
- **Never fabricate a reference you weren't given.** The guideline's validity
  depends on its provenance.
- **Call `mark_drafted` BEFORE the first Write of guideline files.** This flips
  the reviewer's UI to drafting mode; skipping it leaves the UI in gathering
  state and confuses the document panel.
- **One Write per file.** Re-writing a file multiple times in one session is
  wasteful and error-prone; gather all content, then Write once.
- **Use kebab-case for the task-id.** Platform tooling uses the task-id as a
  directory name and URL segment; mixed case or underscores break lookups.
- **Keep the v0 draft small.** Phenotype validation and concordance rubrics
  should ship 1-5 leaf criteria in v0; expand later via `chart-review-improve`.
  Scoring systems (CHA₂DS₂-VASc, RUCAM, MELD, etc.) are exempt — their
  component count is determined by the published score and isn't optional.
  **Why:** a small v0 is easier to calibrate, but for a scoring system every
  component is structurally required to compute the rollup; truncating
  components produces an invalid score.
  **How to apply:** if the user's research goal names an existing scoring
  system, ship every canonical component as a leaf and add the rollup as a
  derived final_output. If the goal is a phenotype or concordance rubric,
  pick the 1-5 leaves that most directly answer the research question.

- **Every criterion with `is_final_output: true` MUST have a `derivation:` block.**
  **Why:** the loader uses the derivation expression to compute the rollup; without
  it the agent answers the field directly and can contradict the prose rule.
  **How to apply:** in Phase 1, when the user wants a derived criterion, ask for the
  combining rule and emit `derivation.expr` — never describe the rule only in
  extraction-guidance prose.

- **`overview_prose` documents the FINAL rubric state, not the build trajectory.**
  When writing meta.yaml, describe what the rubric is — denominator, anchor,
  outcome — without including phrases like "we initially considered", "after
  revising", "our first version", "we pivoted", "scope drift". The trajectory
  belongs in the builder transcript; the rubric's overview reads like
  documentation, not a chat history. The validator emits a
  `overview_prose_trajectory_residue` warning if reversion language is
  detected. If the residue is intentional (e.g. an explicit changelog
  paragraph), set `overview_prose_check: skip` on the meta.yaml.

- **Never emit `# TODO` markers in criterion body prose.**
  **Why:** the marker ships as authoritative content; reviewers miss it.
  **How to apply:** if the skill cannot resolve a reference (e.g. specific code sets
  for a rare condition), emit an explicit `open_questions:` array on the criterion's
  frontmatter — visible to Author pre-flight, impossible to ship past LOCK.

- **Validate before declaring Done.**
  **Why:** the package must validate against `task-meta.schema.json` +
  `criterion-file.schema.json`; otherwise Studio renders blank and TRY fails.
  **How to apply:** call `validate_package`
  (`mcp__chart_review_guideline_builder__validate_package`) after the last file
  write; iterate on diagnostics until `ok: true`.

## Troubleshooting

**Reviewer wants to skip output_shape:** Push back once ("Output shape reframes
every later decision — locking it takes 30 seconds and saves rework."). If they
still insist, default to outcome-first and proceed.

**Reviewer pivots mid-conversation:** Accept the pivot. Drop your current
question; continue with theirs. Come back to skipped topics when needed.

**Two answers contradict each other:** Surface the contradiction in plain text:
"Earlier you said X but now Y — which is the rule and which is the exception?"

**Reviewer says "draft now" before you'd planned:** Do it. They have judgment.
Call `mark_drafted` and Write with what you have. Record unresolved gaps as
entries in the criterion's `open_questions:` frontmatter array — never as
`# TODO` comments in the body prose.

**Reviewer wants to change output_shape after drafting:** Ask first — "Changing
output shape rewrites every criterion. Want me to do that, or did you mean
something narrower?" If yes, Read every criterion file and rewrite each.
