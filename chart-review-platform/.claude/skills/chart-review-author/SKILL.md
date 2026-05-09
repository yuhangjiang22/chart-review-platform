---
name: chart-review-author
description: >
  Drafts a new chart-review guideline package from a research objective and
  reference materials. Use when the user says "draft a guideline", "create a
  chart review protocol", "design a phenotype rubric", "I want to validate
  [condition]", "set up a chart review for [study]", or provides published
  guidelines, SOPs, or papers and asks to turn them into a structured rubric.
  Produces a complete guideline directory under .claude/skills/chart-review-<task-id>/
  with meta.yaml (status: draft), criteria/*.yaml, and optional seed keyword_sets, code_sets,
  and edge_cases. Composes with chart-review-build for interactive step-by-step
  authoring, and with chart-review-calibrate to validate the draft before
  locking. For interactive drafting via the Studio Authoring tab, prefer
  chart-review-build instead.
metadata:
  author: chart-review-platform
  version: "0.2.0"
---

# Guideline Authoring

Turns a clinical research question plus reference material into a structured
**guideline package** (the data artifact the `chart-review` skill consumes).
This skill reads everything the user points at, synthesizes the protocol shape,
and writes the full draft directory. It is a batch authoring tool — for
conversational step-by-step authoring, use `chart-review-build` instead.

## When to use

- User says "draft a guideline", "create a chart-review protocol", "design a
  phenotype rubric", "I want to validate [condition]", or "set up a chart
  review for [study]"
- User pastes a published guideline, SOP, or paper excerpt and asks to turn it
  into a structured rubric
- A research team needs a starter draft fast; they'll iterate later with
  `chart-review-calibrate` and `chart-review-improve`

Do not use when the user wants to work through decisions one question at a time
— that is `chart-review-build`.

## Inputs

The reviewer provides:

- **task_id** (kebab-case, e.g. `pulmonary-embolism-phenotype`) — becomes the
  draft directory name. If not provided, ask.
- **Objective** — 2-5 sentences describing what the chart review answers.
- **Reference materials** — any of: file paths (Read them), URLs (WebFetch if
  available; otherwise ask for paste), or text pasted in the message.
- **Optional**: an existing guideline to use as a structural template
  (e.g. `guidelines/lung-cancer-phenotype/`). Read its meta.yaml and a few
  criteria to match style.

## Procedure

1. **Read every reference.** Use Read/Glob/Grep/WebFetch to gather all material
   the user pointed at. Don't skip — references are the source of truth for
   definitions and code sets.

2. **Identify the protocol shape:**
   - **Final output**: usually a single labeled outcome. What 2-5 categories?
   - **Lookback / time windows**: "within 12 months", "at index", "lifetime"?
     Define each as a `time_windows:` entry in meta.yaml.
   - **Source-document priority**: when multiple sources address the same
     question, which wins? Capture as `meta.source_document_priority`.

3. **Sketch 5-12 criteria — each one atomic.** Atomicity is the single most
   important authoring discipline. A Criterion is atomic when it expresses one
   decision over one piece of evidence with one answer schema. Read
   `skills/chart-review/references/atomic-criteria.md` BEFORE drafting any
   Criterion — the seven-item checklist there is the bar this skill must meet.
   In short:

   - **Single decision.** Not "X and Y", not "X or Y", not "X if Y else Z".
   - **Single answer schema.** Enum values share one semantic axis; don't mix
     outcome and reason in the same enum.
   - **Single time scope.** "Active" and "ever" are two criteria, not one.
   - **Single source class** OR an explicit `derivation` that names its leaf
     dependencies.
   - **Gate vs answer separated.** Use `is_applicable_when` for prerequisites;
     don't fold "if pathology exists, then..." into prose.

   Prefer:
   - Enum schemas (`enum: [yes, no, no_info]`) over free text
   - Boolean (`type: boolean`) for simple presence/absence
   - Numeric (`type: [number, "null"]`) for measurements
   - Group criteria by `group:` (e.g. `pathology`, `imaging`, `codes`, `clinical`)

   When in doubt, **split rather than bundle**. Two atomic criteria with a
   derivation that combines them is always better than one compound criterion.

4. **Apply gates and derivations.** Chain criteria with `is_applicable_when:`
   and compute the final label via a `derivation:` DSL expression. See
   `references/yaml-templates.md` for field-by-field syntax.

5. **Write each criterion file.** Full template in `references/yaml-templates.md`.
   Per-criterion rules: do not invent ICD/LOINC/SNOMED codes — leave a TODO if
   unknown. Keep `prompt` to one sentence. At least one example in
   `guidance_prose.examples`.

6. **Optionally seed operational artifacts** when references provide them:
   - `keyword_sets/<id>.yaml` — specific synonyms/abbreviations/hedge phrases
   - `code_sets/<id>.yaml` — code families you can name confidently (with
     `excludes:` for history-only codes)
   - `edge_cases.yaml` — traps the reference explicitly warns about

   Don't seed any artifact you're not confident about. Reviewers accumulate
   them later via `chart-review-improve`.

7. **Write meta.yaml.** Capture task_type, review_unit, manual_version
   (`0.1.0-draft`), index_anchor, time_windows, final_output, and
   overview_prose. See `chart-review-build/references/file-templates.md`
   for the canonical file shapes (this skill emits the SAME bundle as
   chart-review-build).

8. **Write the bundle** at `.claude/skills/chart-review-<task-id>/`:
   - `SKILL.md` (skill stub)
   - `meta.yaml` (include `status: draft` — the loader uses this maturity
     flag to distinguish drafts from locked guidelines; LOCK-only actions
     remain disabled until the status flips to `locked`)
   - `references/criteria/<field_id>.md` × N
     (markdown with YAML frontmatter + body sections — NOT pure YAML,
     and NOT a single file with nested `fields[]`. One atomic field per
     file. See chart-review-build/references/file-templates.md for the
     exact shape.)
   - `references/keyword_sets/*.yaml` (if seeded)
   - `references/code_sets/*.yaml` (if seeded)
   - `references/edge_cases/*.yaml` (if seeded)

   The legacy `.claude/skills/drafts/chart-review-<id>/` location is no
   longer read by the loader. Writing there produces invisible artifacts;
   `npm run migrate-drafts` exists to consolidate any remaining legacy
   drafts to the canonical path.

9. **Summarize for the reviewer.** End with 3-5 sentences: criteria count, key
   gates/derivations, what was seeded vs left as TODO, and the recommended next
   step (suggest running `chart-review-calibrate` on a sample of charts).

## Universal references

- See `skills/chart-review/references/atomic-criteria.md` for the atomicity
  definition + seven-item authoring checklist + common violations and how to
  split them. **Required reading before drafting any Criterion.**
- See `skills/chart-review/references/lifecycle.md` for the draft → locked
  pipeline this skill feeds into.
- See `skills/chart-review/references/evidence-citation.md` for citation
  discipline that downstream reviewers will apply.

## Skill-specific references

- `../chart-review-build/references/file-templates.md` — full file
  templates (markdown frontmatter for criteria, YAML for meta /
  keyword_sets / code_sets / edge_cases). **Required reading before
  any Write.** This skill emits the same bundle shape as
  chart-review-build, so the templates live there.
- `references/examples.md` — worked examples: authoring from a pasted SOP
  and from a research objective alone
- `references/troubleshooting.md` — fixes for common problems (too many
  criteria, paywalled references, conflicting sources, unknown codes)

## Hard rules (with reasons)

- **Every Criterion must be atomic** per the seven-item checklist in
  `skills/chart-review/references/atomic-criteria.md`. Atomicity is a load-
  bearing precondition for the platform's per-criterion κ, criterion-level
  rerun, schema_hash carry-forward, and adjudication granularity. A single
  compound Criterion silently breaks all four. When in doubt — split.
- **Output goes ONLY under `.claude/skills/chart-review-<task-id>/`.**
  Always include `status: draft` in meta.yaml — this is the maturity flag
  the loader uses to distinguish drafts from locked guidelines. Locking
  is a status flip (`status: locked`), not a directory rename, governed
  by `chart-review-calibrate`. Never write to the legacy
  `.claude/skills/drafts/chart-review-<id>/` path — those drafts are
  invisible to the loader.
- **Per-criterion files MUST be markdown (.md) with YAML frontmatter, NOT
  pure YAML, and one atomic field per file.** The reviewer's loader
  walks `references/criteria/*.md` and parses the frontmatter via the
  `---` delimiters. A `.yaml` file at the same path is silently ignored.
  Multi-field blobs with nested `fields[]` arrays produce zero
  reviewable criteria. See chart-review-build/references/file-templates.md
  for the exact shape.
- **Never invent clinical codes you don't know.** Incorrect code sets silently
  bias every downstream agent review; leave a TODO comment and let the reviewer
  supply them.
- **Never fabricate a reference you weren't given.** The guideline's validity
  depends on its provenance being traceable to real sources.
- **Use kebab-case for the task-id.** Platform tooling uses the task-id as a
  directory name and URL segment; mixed case or underscores break lookups.
- **Keep the draft small: 5-12 criteria for v0.** A large v0 is hard to
  calibrate; reviewers can add criteria once the core rubric is validated.
