name: add-phenotype-skill

description: Add a new phenotype skill (= new chart-review task) to the platform

A "task" in chart-review-platform-v2 is a phenotype. Each task = one skill package under .agents/skills/chart-review-<task-id>/. The pipeline modules + agent runtime + MCP tools are shared; only the skill differs per task.

Recipe:

1. Create .agents/skills/chart-review-<task-id>/ with:
   - SKILL.md           the agent prompt (activated by description match)
   - meta.yaml          task metadata (review_unit, stratify_by, final_output, …)
   - package.json       {"name":"@chart-review/skill-chart-review-<task-id>","version":"0.1.0","private":true,...}
   - references/criteria/<field>.md     one per leaf criterion
   - references/keyword_sets/           search terms (optional)
   - references/code_sets/              ICD / OMOP codes (optional)
   - references/edge_cases/             disambiguators (optional)

2. Run `npm install` from chart-review-platform-v2/. The workspace glob ".agents/skills/*" auto-registers the new package.

3. (Optional) Add a corpus of synthetic patients under corpus/patients/<patient-id>/ with ground-truth labels for this task.

4. The UI auto-lists the new task on next page load (GET /api/tasks reads the skill registry).

What does NOT change: pipeline-extract, agent-provider-*, mcp-tools, server-http, workflow-chart-review. The task is pure data.

If the new task needs a NEW MCP tool (not just new criteria), create a sibling packages/mcp-tools-<task>/ package and have the skill declare it as a peer dependency. The MCP server loader can refuse to activate a skill whose tools aren't loaded.
