# Verb/noun pivot — chart-review skill + guidelines/

Architectural pivot away from "each protocol IS a Claude Code skill" toward
"a small set of verb skills (chart-review, guideline-authoring,
guideline-improvement, …) operate on guideline packages (data, not skills)."

The shift:

| Before | After |
|---|---|
| `.claude/skills/lung-cancer-phenotype/SKILL.md` IS the skill | `.claude/skills/chart-review/SKILL.md` is the only skill (for now); `lung-cancer-phenotype` is data |
| Skill data nested under `references/` (per Anthropic skill guide) | Data lives flat under `guidelines/lung-cancer-phenotype/` (no `references/` wrapper — guideline packages are data, not skills) |
| Agent activates `lung-cancer-phenotype` skill by description match | Agent activates the `chart-review` skill; the skill's procedure says "read the guideline at the path the platform passed" |
| Each new protocol = a new skill that needs description tuning | Each new protocol = a new directory under `guidelines/` (no skill changes) |

## What ships in this pivot

1. **Restructure**: `git mv .claude/skills/lung-cancer-phenotype/references/* guidelines/lung-cancer-phenotype/`. Drop the SKILL.md in `lung-cancer-phenotype/` (it's not a skill anymore). Drop the `references/` wrapper (the data is no longer a skill — the guide doesn't apply).

2. **Create the `chart-review` verb skill** at `.claude/skills/chart-review/SKILL.md`. Frontmatter with strong trigger phrases ("review this chart", "is this lung cancer confirmed", etc.). Procedure: read the active guideline path from the prompt, walk its `criteria/`, consult `keyword_sets/`/`code_sets/`/`edge_cases.yaml`/`exemplars/` per each criterion's `uses:` block, commit answers via the chart_review_state MCP tools.

3. **Server loaders** (`skill-bundle.ts`, `tasks.ts`) now resolve guidelines at `guidelines/<id>/` (env: `CHART_REVIEW_GUIDELINES_ROOT`). Drop the `.claude/skills/` lookup and the `references/` fallback. Keep `tasks/<id>/` as a fallback for any legacy bundle.

4. **`composeAgentOptions`** gains a `guidelinePath` parameter. When provided, the systemPrompt reads `Active guideline: <id> at <path>` so the chart-review skill knows where to read.

5. **`ai-client.ts`** computes the active guideline path from `task_id` and passes it to `composeAgentOptions`. The `extraSystemPrompt` says "Activate the chart-review skill via the Skill tool."

6. **Kebab-case `task_id`** rename throughout active code (server.ts DEFAULT_TASK_ID, 3 TS test files, 2 Python test files, the legacy `tasks/lung_cancer_phenotype.md` → `tasks/lung-cancer-phenotype.md`).

## What doesn't ship in this pivot (deferred)

- **`guideline-authoring` skill** — drafts a new guideline package from objective + references.
- **`guideline-improvement` skill** — sample patients, HITL ground truth, propose updates.
- **`guideline-calibration` skill** — pre-lock blind-review + κ.
- **`cohort-feedback` skill** — drift / Role-C analysis on a locked guideline.
- **`methods-section-drafting` skill** — academic methods text from locked + cohort.

These follow the same pattern. The chart-review skill demonstrates the shape; adding more is mechanical.

## Acceptance

- ✅ `guidelines/lung-cancer-phenotype/` exists with meta.yaml + criteria/ + keyword_sets/ + code_sets/ + edge_cases.yaml + exemplars/. No SKILL.md inside.
- ✅ `.claude/skills/chart-review/SKILL.md` is the only skill in the project.
- ✅ `loadSkillBundle("lung-cancer-phenotype")` reads from `guidelines/lung-cancer-phenotype/` and returns CompiledTask + operational layer.
- ✅ `composeAgentOptions({ taskId, guidelinePath })` surfaces both in the systemPrompt.
- ✅ `ai-client.ts` passes the absolute guideline path.
- ✅ TS suite: same baseline as before this pivot (1 pre-existing failure in auto-role-c).
- ✅ Python suite: 107/107.
