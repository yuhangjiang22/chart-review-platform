name: add-mcp-tool

description: Add a new MCP tool to the chart_review_state server

The MCP tool surface lives across three packages:

- @chart-review/mcp-core            transport-neutral handler functions + types
- @chart-review/mcp-server-anthropic  Anthropic Claude Agent SDK adapter
- @chart-review/mcp-server-stdio    @modelcontextprotocol/sdk stdio adapter (used by Codex)

Both adapters wrap the same handlers from mcp-core, so a tool added once propagates to both runtimes.

Recipe:

1. Add the handler to packages/mcp-core/src/index.ts:
   - Define the Zod input schema.
   - Export a typed function (takes an McpSession + typed args, returns a CallToolResult).
   - Wire any side effects (audit append, review-state write) through the existing primitives — never bypass them.

2. Register in the Anthropic adapter at packages/mcp-server-anthropic/src/index.ts:
   - Add a `tool(...)` block referencing the handler.
   - Append to the createSdkMcpServer({tools}) tools record.

3. Register in the stdio adapter at packages/mcp-server-stdio/src/index.ts:
   - Add an `if (want("<tool_name>")) { server.tool(...) }` block.

4. If the tool reads or writes review_state, also add an applyUiAction case in packages/domain-review/src/review-state.ts (or extend an existing case). Audit + faithfulness gate happen automatically.

5. Run `npm run typecheck` from chart-review-platform-v2/.

6. Smoke-test by running a pilot iter and verifying the tool appears in the audit log: /api/runs/:runId/patients/:patientId/audit.
