name: code-review

description: Review a change to chart-review-platform-v2 against repo conventions

When reviewing a change, walk the checklist in order. Surface every issue with file:line.

Package boundary:
- Does any file under packages/*/ import via relative paths into ../../server/lib/ or another package's src? If so: that's a cross-package boundary break. Should be `@chart-review/<package>` instead.
- Did the change add a new package? If yes, is it listed under workspaces in chart-review-platform-v2/package.json (or covered by a glob like packages/*)?

Shim discipline:
- Files under server/lib/ that aren't shims must declare why — every file ported to a package gets a one-line `export * from "@chart-review/<name>";` shim left at the original location.
- New code should NOT import from server/lib/<X>.js — it should import from @chart-review/<X> directly. Old call sites that go through shims are tolerated during migration.

Skill format (.agents/skills/* changes):
- Phenotype skills need: SKILL.md (with YAML frontmatter), meta.yaml, references/criteria/, package.json declaring @chart-review/skill-<name>.
- meta.yaml field naming: review_unit, stratify_by, final_output, task_version. Don't rename without updating @chart-review/rubric's parser.

MCP changes (packages/mcp-*):
- New tool added in mcp-core MUST also be registered in BOTH mcp-server-anthropic AND mcp-server-stdio. If only one is wired, half the runtimes will silently miss it.
- find_quote_offsets is the ONLY legitimate way to compute citation offsets. Any new code computing offsets without calling it is a faithfulness break.

Faithfulness:
- Any new evidence-write code path must go through @chart-review/faithfulness's verifyEvidence before the write lands in review_state. The MCP layer already enforces this; bypasses via direct file writes are bugs.

Tests:
- Did a change to a leaf utility add a test? Parity tests (TS ↔ Python) under lib-py/ matter for contract-eval and derivation. Surface if the parity test wasn't updated.

Specific patterns to flag:
- New env-var reads outside the canonical seam (model-config / patients / etc.) — should go through the seam.
- New REST routes that don't appear in the route table in server/index.ts.
- New @anthropic-ai/claude-agent-sdk imports outside agent-provider-claude or mcp-server-anthropic packages.
- New @modelcontextprotocol/sdk imports outside mcp-server-stdio.
