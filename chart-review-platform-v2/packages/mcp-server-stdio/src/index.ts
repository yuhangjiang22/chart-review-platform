// mcp-stdio-server.ts — standalone MCP server speaking JSON-RPC over stdio.
//
// Used when the agent provider is something other than Anthropic's
// in-process SDK (Codex, OpenAI direct, Ollama, etc.). The same handler
// functions in mcp-handlers.ts power both this subprocess and the
// in-process server in mcp-tools.ts; only the transport differs.
//
// Invocation:
//   tsx server/mcp-stdio-server.ts             # dev
//   node dist/server/mcp-stdio-server.js       # production after build
//
// Required env vars (set by the agent runtime when spawning this process):
//   CHART_REVIEW_MCP_PATIENT_ID  — active patient
//   CHART_REVIEW_MCP_TASK_ID     — active rubric (compiled task id)
//   CHART_REVIEW_MCP_SESSION_ID  — opaque session id used for audit trail
//
// Optional env vars:
//   CHART_REVIEW_PLATFORM_ROOT   — overrides the platform root (filesystem state)
//   CHART_REVIEW_MCP_TOOLS       — comma-separated tool allowlist (subset)
//
// Behavior:
//   - Reads JSON-RPC frames from stdin, writes responses to stdout
//   - Logs to stderr (stdout is reserved for the MCP wire protocol)
//   - Exits when stdin closes (parent process detached)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  evidenceSchema,
  initSession,
  setFieldAssessment as hSetFieldAssessment,
  getReviewState as hGetReviewState,
  setSummary as hSetSummary,
  recommendKeywords as hRecommendKeywords,
  selectEvidence as hSelectEvidence,
  findQuoteOffsets as hFindQuoteOffsets,
  setReviewStatus as hSetReviewStatus,
  type CallToolResult,
  type McpSession,
} from "@chart-review/mcp-core";
import { loadCompiledTask } from "@chart-review/tasks";

function bail(msg: string): never {
  // stderr — stdout is reserved for JSON-RPC frames
  process.stderr.write(`[mcp-stdio-server] FATAL: ${msg}\n`);
  process.exit(2);
}

// ── 1. Read session config from env ──────────────────────────────────

const patientId = process.env.CHART_REVIEW_MCP_PATIENT_ID;
const taskId = process.env.CHART_REVIEW_MCP_TASK_ID;
const sessionId = process.env.CHART_REVIEW_MCP_SESSION_ID;

if (!patientId) bail("CHART_REVIEW_MCP_PATIENT_ID env var is required");
if (!taskId) bail("CHART_REVIEW_MCP_TASK_ID env var is required");
if (!sessionId) bail("CHART_REVIEW_MCP_SESSION_ID env var is required");

const task = loadCompiledTask(taskId);
if (!task) bail(`Task ${taskId} not found at runtime`);

const session: McpSession = { patientId, task, sessionId };
initSession(session);

// ── 2. Build the McpServer + register the 7 handlers ────────────────

const server = new McpServer({
  name: "chart_review_state",
  version: "0.6.0",
});

// Tool subset, mirroring the in-process adapter's CHART_REVIEW_MCP_TOOLS
// allowlist behavior so subprocess + in-process registrations match.
const toolSubset = process.env.CHART_REVIEW_MCP_TOOLS
  ? new Set(
      process.env.CHART_REVIEW_MCP_TOOLS.split(",").map((s) => s.trim()),
    )
  : null;
const want = (name: string) => !toolSubset || toolSubset.has(name);

if (want("set_field_assessment")) {
  server.registerTool(
    "set_field_assessment",
    {
      description: [
        "Record an answer for one protocol field on the current patient.",
        "The platform validates the field_id against the compiled task and",
        "runs a faithfulness pre-check on every cited note quote. If the",
        "offsets do not resolve to the verbatim_quote in the source note,",
        "the call is rejected — do not invent quotes or guess offsets.",
      ].join(" "),
      inputSchema: {
        field_id: z.string(),
        answer: z.any().optional(),
        confidence: z.enum(["low", "medium", "high"]).optional(),
        evidence: z.array(evidenceSchema).optional(),
        rationale: z.string().optional(),
        edit_reason: z
          .enum([
            "missed_evidence",
            "misinterpreted",
            "wrong_rule",
            "criterion_ambiguous",
            "other",
          ])
          .optional(),
        edit_note: z.string().optional(),
        override_of_agent: z.boolean().optional(),
      },
    },
    async (args): Promise<CallToolResult> =>
      hSetFieldAssessment(session, args as any),
  );
}

if (want("get_review_state")) {
  server.registerTool(
    "get_review_state",
    {
      description: "Return the current review state for this patient×task.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => hGetReviewState(session),
  );
}

if (want("set_summary")) {
  server.registerTool(
    "set_summary",
    {
      description: [
        "Record a brief chart summary on the current patient×task.",
        "Use this when the reviewer asks you to summarize the chart;",
        "the platform persists it and the UI surfaces it at the top of",
        "the Review Form pane. Keep brief_summary to 4–6 sentences,",
        "key_conditions to the 3–6 most relevant active diagnoses, and",
        "uncertainties to anything the chart leaves ambiguous.",
      ].join(" "),
      inputSchema: {
        brief_summary: z.string().optional(),
        key_conditions: z.array(z.string()).optional(),
        uncertainties: z.array(z.string()).optional(),
        evidence_files: z.array(z.string()).optional(),
      },
    },
    async (args): Promise<CallToolResult> => hSetSummary(session, args as any),
  );
}

if (want("recommend_keywords")) {
  server.registerTool(
    "recommend_keywords",
    {
      description: [
        "Surface a clinically-aware keyword expansion the reviewer can use",
        "as note-search terms. Always include direct_terms (canonical names),",
        "abbreviations (acronyms a clinician might write), aliases (other ways",
        "the same thing is documented), behavioral_clues (descriptive language",
        "that implies the topic without naming it), treatment_terms (drugs and",
        "interventions specific to the topic), and negation_patterns (phrases",
        "that explicitly RULE OUT the topic — search the reviewer should know",
        "to suppress).",
      ].join(" "),
      inputSchema: {
        topic: z.string(),
        direct_terms: z.array(z.string()).optional(),
        aliases: z.array(z.string()).optional(),
        abbreviations: z.array(z.string()).optional(),
        behavioral_clues: z.array(z.string()).optional(),
        treatment_terms: z.array(z.string()).optional(),
        negation_patterns: z.array(z.string()).optional(),
      },
    },
    async (args): Promise<CallToolResult> =>
      hRecommendKeywords(session, args as any),
  );
}

if (want("select_evidence")) {
  server.registerTool(
    "select_evidence",
    {
      description: [
        "Flag a noteworthy passage in the chart for the reviewer. Use this",
        "when you find supporting OR contradicting evidence the reviewer",
        "should see, even if it is not yet tied to a specific protocol",
        "field. Pass either a note evidence (note_id + span_offsets +",
        "verbatim_quote) or an omop evidence (table + row_id + …). The",
        "platform faithfulness-checks note offsets before persisting and",
        "the UI shows the entry as a clickable card; clicking jumps to",
        "the source note and highlights the span.",
      ].join(" "),
      inputSchema: {
        evidence: evidenceSchema,
        rationale: z.string().optional(),
        category: z
          .enum(["supporting", "contradicting", "context"])
          .optional(),
        field_id: z.string().optional(),
      },
    },
    async (args): Promise<CallToolResult> =>
      hSelectEvidence(session, args as any),
  );
}

if (want("find_quote_offsets")) {
  server.registerTool(
    "find_quote_offsets",
    {
      description: [
        "Locate a snippet inside one of this patient's notes and return",
        "its exact character offsets. Use this BEFORE calling select_evidence",
        "or set_field_assessment with note evidence — feed the snippet you",
        "want to cite, get back the exact span_offsets, then pass those",
        "offsets verbatim to the assessment / evidence call. This avoids the",
        "faithfulness gate rejecting hand-counted offsets.",
        "Whitespace-tolerant: the snippet's whitespace can differ from the",
        "note's; the platform finds the match either way.",
      ].join(" "),
      inputSchema: {
        note_id: z.string(),
        snippet: z.string(),
      },
    },
    async (args): Promise<CallToolResult> =>
      hFindQuoteOffsets(session, args as any),
  );
}

if (want("set_review_status")) {
  server.registerTool(
    "set_review_status",
    {
      description: [
        "Signal that the agent has finished reviewing this patient and all",
        "rubric criteria have been committed via set_field_assessment.",
        "The only accepted value for `status` is 'complete'. The platform",
        "enforces a commit gate: every non-derived, applicable criterion must",
        "have a field_assessment before this call will succeed. If any criteria",
        "are missing, the call returns an error with code 'incomplete_review'",
        "and a list of the missing field_ids — commit those first, then retry.",
      ].join(" "),
      inputSchema: {
        status: z.literal("complete"),
      },
    },
    async (): Promise<CallToolResult> => hSetReviewStatus(session),
  );
}

// ── 3. Connect to stdio + run forever ────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[mcp-stdio-server] ready (patient=${patientId} task=${taskId} session=${sessionId})\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[mcp-stdio-server] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
