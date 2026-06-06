// Standalone stdio MCP server for the 7 chart_review_ner tools.
//
// Parallel to mcp-server-stdio (which serves the phenotype tools);
// shares the same handler functions in mcp-core-ner so both transports
// stay in lock-step.
//
// Invocation:
//   tsx packages/mcp-server-ner-stdio/src/index.ts
//
// Required env vars (set by buildNerMcpServersConfig when spawning):
//   CHART_REVIEW_NER_PATIENT_ID    — active patient
//   CHART_REVIEW_NER_TASK_ID       — active task id
//   CHART_REVIEW_NER_SESSION_ID    — opaque session id for audit-trail
//   CHART_REVIEW_NER_ONTOLOGY_PATH — concepts.json path (resolved by parent)
//
// Optional:
//   CHART_REVIEW_REVIEWS_ROOT      — per-run reviews scratch root override
//   CHART_REVIEW_NER_MCP_TOOLS     — comma-separated tool allowlist

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  listEntityTypes as hListEntityTypes,
  getConceptTree as hGetConceptTree,
  normalizeToOntology as hNormalize,
  locateInSource as hLocate,
  setSpanLabel as hSetSpanLabel,
  setSpanStatus as hSetSpanStatus,
  getSpanReviewState as hGetSpanReviewState,
  type CallToolResult, type NerMcpSession,
} from "@chart-review/mcp-core-ner";
import { loadCompiledTask } from "@chart-review/tasks";

function bail(msg: string): never {
  process.stderr.write(`[mcp-server-ner-stdio] FATAL: ${msg}\n`);
  process.exit(2);
}

// ── 1. Read session config from env ──────────────────────────────────

const patientId = process.env.CHART_REVIEW_NER_PATIENT_ID;
const taskId = process.env.CHART_REVIEW_NER_TASK_ID;
const sessionId = process.env.CHART_REVIEW_NER_SESSION_ID;
const ontologyPath = process.env.CHART_REVIEW_NER_ONTOLOGY_PATH;

if (!patientId) bail("CHART_REVIEW_NER_PATIENT_ID env var is required");
if (!taskId) bail("CHART_REVIEW_NER_TASK_ID env var is required");
if (!sessionId) bail("CHART_REVIEW_NER_SESSION_ID env var is required");
if (!ontologyPath) bail("CHART_REVIEW_NER_ONTOLOGY_PATH env var is required");

const task = loadCompiledTask(taskId);
if (!task) bail(`Task ${taskId} not found at runtime`);

const session: NerMcpSession = {
  patientId,
  task,
  sessionId,
  ontologyPath,
  ...(process.env.CHART_REVIEW_REVIEWS_ROOT
    ? { reviewsRoot: process.env.CHART_REVIEW_REVIEWS_ROOT }
    : {}),
};

// ── 2. Build the McpServer + register the 7 handlers ─────────────────

const server = new McpServer({
  name: "chart_review_ner",
  version: "0.1.0",
});

const toolSubset = process.env.CHART_REVIEW_NER_MCP_TOOLS
  ? new Set(process.env.CHART_REVIEW_NER_MCP_TOOLS.split(",").map((s) => s.trim()))
  : null;
const want = (name: string) => !toolSubset || toolSubset.has(name);

function asMcp(p: Promise<CallToolResult>): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}> {
  return p;
}

if (want("list_entity_types")) {
  server.registerTool(
    "list_entity_types",
    { description: "Return the supported entity types.", inputSchema: {} },
    async () => asMcp(hListEntityTypes(session)),
  );
}

if (want("get_concept_tree")) {
  server.registerTool(
    "get_concept_tree",
    {
      description: "Return the ASCII tree of concept_names under one entity_type.",
      inputSchema: { entity_type: z.string() },
    },
    async (args) => asMcp(hGetConceptTree(session, args as { entity_type: string })),
  );
}

if (want("normalize_to_ontology")) {
  server.registerTool(
    "normalize_to_ontology",
    {
      description: "Map a candidate label to a canonical concept_name.",
      inputSchema: { entity_type: z.string(), label: z.string() },
    },
    async (args) => asMcp(hNormalize(session, args as { entity_type: string; label: string })),
  );
}

if (want("locate_in_source")) {
  server.registerTool(
    "locate_in_source",
    {
      description: "Resolve authoritative (start, end) offsets via anchor → text two-stage lookup.",
      inputSchema: {
        note_id: z.string(),
        anchor: z.string(),
        text: z.string(),
      },
    },
    async (args) =>
      asMcp(hLocate(session, args as { note_id: string; anchor: string; text: string })),
  );
}

if (want("set_span_label")) {
  server.registerTool(
    "set_span_label",
    {
      description: "Commit one span (faithfulness-gated).",
      inputSchema: {
        note_id: z.string(),
        text: z.string(),
        anchor: z.string(),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        entity_type: z.string(),
        concept_name: z.string(),
        status: z.enum(["mapped", "novel_candidate", "rejected"]).optional(),
        override_reason: z.string().optional(),
      },
    },
    async (args) => asMcp(hSetSpanLabel(session, args as Parameters<typeof hSetSpanLabel>[1])),
  );
}

if (want("set_span_status")) {
  server.registerTool(
    "set_span_status",
    {
      description: "Update an existing span's status.",
      inputSchema: {
        span_id: z.string(),
        status: z.enum(["mapped", "novel_candidate", "rejected"]),
        override_reason: z.string().optional(),
      },
    },
    async (args) => asMcp(hSetSpanStatus(session, args as Parameters<typeof hSetSpanStatus>[1])),
  );
}

if (want("get_span_review_state")) {
  server.registerTool(
    "get_span_review_state",
    { description: "Return all committed spans for this patient × task.", inputSchema: {} },
    async () => asMcp(hGetSpanReviewState(session)),
  );
}

// ── 3. Start the transport ───────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport).catch((e: unknown) => {
  process.stderr.write(`[mcp-server-ner-stdio] connect failed: ${String(e)}\n`);
  process.exit(1);
});
