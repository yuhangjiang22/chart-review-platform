# Skill refinement pattern (skill-creator-driven)

**Date:** 2026-05-03
**Status:** Pattern proven on the main `chart-review` skill; ready to apply to 7 siblings in a future session
**Predecessors:**
- `2026-05-03-skill-architecture-design.md` (target structure)
- `2026-05-03-skill-restructure.md` (Phase A/B implementation plan)
- Anthropic's *Building Skills for Claude* guide (philosophy)
- The `claude-seo` repo (main + siblings + shared references pattern)

The proof of this pattern is in commit history at `.claude/skills/chart-review/`:
- `SKILL.md` shrunk from 230 → 125 lines (orchestrator shape with Quick Reference)
- 5 new `references/*.md` files (561 lines of detail loaded on demand)
- Description tightened with composability hint
- "Why" replaces most "MUST" usages

The remaining 7 sibling skills follow the same pattern. This document is the
checklist for refining each one. No new design decisions needed — just
mechanical application.

## The 7 skills awaiting refinement

After Phase A renames in `2026-05-03-skill-restructure.md` land, these become:

| Renamed skill | Today's location | Estimated effort |
|---|---|---|
| `chart-review-author` | `.claude/skills/guideline-authoring/SKILL.md` | small (probably 0–1 reference file) |
| `chart-review-build` | `.claude/skills/chart-review-guideline-builder/SKILL.md` | small to medium |
| `chart-review-calibrate` | `.claude/skills/guideline-calibration/SKILL.md` | small |
| `chart-review-improve` | `.claude/skills/guideline-improvement/SKILL.md` | medium |
| `chart-review-cohort` | `.claude/skills/cohort-feedback/SKILL.md` | small |
| `chart-review-copilot` | `.claude/skills/review-copilot/SKILL.md` | small |
| `chart-review-methods` | `.claude/skills/methods-section-drafting/SKILL.md` | small |

Each refinement = 15–30 minutes. Total: 2–3 hours of focused work.

## The refinement checklist (per skill)

Apply each step in order. Use the chart-review main skill as the visual
reference for the target shape.

### Step 1: Read the current SKILL.md

What's currently inline that doesn't need to be? Categorize each section:
- **Orchestration / metadata** — stays in body (shows up in every invocation)
- **Detailed procedure / examples / troubleshooting** — candidates for `references/`
- **Cross-cutting reference data (codes, schemas, prose tables)** — definitely `references/`

The chart-review main skill kept its body for the universal procedure (read
guideline → search → cite → commit) but moved the long evidence-citation rules,
the MCP tool docs, and the worked examples to `references/`.

### Step 2: Tighten the description

The description triggers the skill. It should:

- **Include specific user phrases** ("when the user says…")
- **State what + when + key capabilities** in the format Anthropic recommends
- **Mention composability** if the skill works with siblings (e.g., "Composes with chart-review for the universal review procedure")
- **Be a touch "pushy"** to combat undertriggering — see Anthropic's skill-creator guidance
- **Stay under 1024 characters**

Example pattern (from the main `chart-review`):

```yaml
description: >
  Reviews a patient's electronic health record against a clinical phenotyping
  rubric (also called a chart-review guideline or abstraction protocol). Use
  whenever the user says "review this chart", "review this patient", "abstract
  this case", "is this lung cancer confirmed", "fill out the review form",
  "does this patient meet the criteria", or asks any question that maps to a
  guideline criterion. Reads notes, pathology reports, imaging, ICD codes, and
  OMOP-style structured data; consults the active phenotype skill's criteria,
  code sets, edge cases, and exemplars; commits answers via the
  chart_review_state MCP tools (set_field_assessment, select_evidence,
  set_summary, find_quote_offsets). Composes with phenotype scope-skills
  (chart-review-<noun>-phenotype) that provide the rubric definition.
```

For each sibling skill, follow this structure but replace the trigger phrases
with the ones specific to that skill (the existing descriptions already have
most of these; just polish + add composability hints).

### Step 3: Rewrite SKILL.md as ~80–200 line body

Target shape:

```markdown
---
name: chart-review-<verb>
description: <tightened description>
metadata:
  author: chart-review-platform
  version: "0.2.0"
---

# <Display Title>

<2–4 sentence overview — what this skill does, where it sits in the platform.>

## When to use
<Concise expansion of the description. Bullet list of trigger scenarios is fine.>

## Procedure
<The skill's actual workflow. ~50–150 lines. Cross-reference references/ for detail.>

## Universal references
<Pointer to the main chart-review skill's references/ for shared docs.>
- See `skills/chart-review/references/evidence-citation.md` for citation discipline.
- See `skills/chart-review/references/mcp-tools.md` for MCP tool details.

## Skill-specific references
<List the references/*.md files in THIS skill if any exist.>

## Hard rules (with reasons)
<Per skill-creator philosophy: explain WHY, not just MUST. Each rule gets a sentence of reasoning.>
```

### Step 4: Extract long-form into `references/`

If the body would exceed ~250 lines, identify what to extract. Common candidates:

- **Worked examples / walkthroughs** → `references/examples.md`
- **Detailed procedure for a complex sub-step** → `references/procedure-<step>.md`
- **Reference data tables** → `references/<topic>.md`
- **Troubleshooting** → `references/troubleshooting.md`

Each reference file should:
- Have a clear single-sentence purpose at the top
- Be loadable on demand from a body section that says "see `references/X.md`"
- Be under ~150 lines unless it's a true reference table (codesets, schemas)

### Step 5: Apply "explain why, not just MUST"

For each "MUST" or "ALWAYS" in the original SKILL.md, ask: *what's the
underlying reason?* Often the reason is more useful than the directive. The
chart-review main skill's hard rules now read:

> **Read only the active patient's chart and the active phenotype skill's
> references.** Other patients' folders are forbidden — chart-review studies
> are per-patient and cross-contamination would invalidate the data.

Instead of:

> **Only inspect files inside the agent's working directory.**

The reason ("would invalidate the data") helps the agent generalize when
edge cases appear.

### Step 6: Validate

Quick smoke checks per the skill-creator guide:

- [ ] `name:` is kebab-case and matches folder name
- [ ] `description:` includes specific trigger phrases + what + when + key capabilities
- [ ] Body is < 500 lines (target ~80–250)
- [ ] No README.md inside the skill folder (skill-creator rule)
- [ ] No "claude" or "anthropic" in skill name (reserved)
- [ ] Cross-references to other skills' references/ use relative paths (`skills/chart-review/references/X.md`)

### Step 7: Commit

```bash
git add .claude/skills/chart-review-<verb>/
git commit -m "refactor(<verb>-skill): apply skill-creator philosophy"
```

## Per-skill notes (estimating what each one needs)

These are educated guesses; verify by reading the current SKILL.md.

**`chart-review-author` (was guideline-authoring):**
The drafting workflow is multi-step (intake → research → criteria draft → keyword/code seeds). Body probably extracts to:
- `references/case-definition-template.md` — the meta.yaml template
- `references/criteria-template.md` — the per-criterion YAML template

**`chart-review-build` (was chart-review-guideline-builder):**
Interactive workflow with state machine (interview phase → draft phase → review phase). Body probably extracts to:
- `references/interview-questions.md` — the question bank
- `references/state-machine.md` — phase transitions

**`chart-review-calibrate` (was guideline-calibration):**
Mostly mechanical (κ computation + per-criterion bucketing). Body probably stays small. Maybe one reference: `references/kappa-thresholds.md` (Landis & Koch buckets).

**`chart-review-improve` (was guideline-improvement):**
Clustering + proposal generation. Body probably extracts to:
- `references/proposal-yaml-schema.md`
- `references/clustering-heuristics.md`

**`chart-review-cohort` (was cohort-feedback):**
Drift triage + pattern surfacing. Body probably stays small. Maybe one reference: `references/role-c-framework.md`.

**`chart-review-copilot` (was review-copilot):**
Read-only Q&A surface. Body probably stays small (no commit logic to document).

**`chart-review-methods` (was methods-section-drafting):**
Prose generation. Body probably extracts to:
- `references/methods-template.md` — the 7-block structure
- `references/journal-conventions.md` — past-tense, third-person, etc.

## How to dispatch this in a future session

If running with subagents:

```
For each of the 7 skills above:
  Dispatch a fresh subagent with:
    - The skill's current path
    - This document as the checklist
    - The chart-review main skill as the visual reference
    - "Refine this skill per the 7-step checklist. Commit when done."
```

Or in an interactive session, work through one at a time using this checklist.
Each takes 15–30 minutes.

## When this is done, what's next

After all 8 skills (main + 7 siblings) are refined:

1. **Phenotype scope-skill migration** — apply the same skill-format discipline
   to the new `chart-review-lung-cancer-phenotype/` skill (per
   `2026-05-03-skill-restructure.md` Phase D).
2. **Platform code path updates** — `app/server/phenotype-skill.ts` reads from
   the new skill location (Phase E).
3. **End-to-end validation** — re-run iter_011 against the migrated structure
   (Phase F).
4. **Then: criterion-level rerun build** — the next post-MVP feature, which
   consumes the `schema_hash` now in the criterion files' frontmatter.

The skill-restructure plan (`2026-05-03-skill-restructure.md`) has the full
sequence. This pattern doc is for the per-skill refinement step within Phase B.
