// chart_review_adherence — standalone MCP server speaking JSON-RPC over stdio.
//
// Mirror of mcp-server-stdio (phenotype) and mcp-server-ner-stdio (NER).
// Spawned by the Codex CLI per-run via .codex/config.toml. Receives session
// context via env vars and re-uses the transport-neutral handlers in
// @chart-review/mcp-core-adherence.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  listQuestions as hListQuestions,
  readQuestion as hReadQuestion,
  setQuestionAnswer as hSetQuestionAnswer,
  getAdherenceState as hGetState,
  setReviewStatus as hSetStatus,
  listNotesTool as hListNotes,
  readNotesTool as hReadNotes,
  searchNotesTool as hSearchNotes,
  listStructuredDataTool as hListStructured,
  readStructuredDataTool as hReadStructured,
  type CallToolResult,
  type AdherenceMcpSession,
} from "@chart-review/mcp-core-adherence";
import { loadCompiledTask } from "@chart-review/tasks";

function bail(msg: string): never {
  process.stderr.write(`[mcp-adherence-stdio] FATAL: ${msg}\n`);
  process.exit(2);
}

const patientId = process.env.CHART_REVIEW_ADH_PATIENT_ID;
const taskId    = process.env.CHART_REVIEW_ADH_TASK_ID;
const sessionId = process.env.CHART_REVIEW_ADH_SESSION_ID;
if (!patientId) bail("CHART_REVIEW_ADH_PATIENT_ID env var is required");
if (!taskId)    bail("CHART_REVIEW_ADH_TASK_ID env var is required");
if (!sessionId) bail("CHART_REVIEW_ADH_SESSION_ID env var is required");

const task = loadCompiledTask(taskId);
if (!task) bail(`Task ${taskId} not found at runtime`);

const session: AdherenceMcpSession = { patientId, task, sessionId };
const server = new McpServer({ name: "chart_review_adherence", version: "0.1.0" });

server.registerTool(
  "list_questions",
  {
    description: "Return the adherence task's question framework — every question_id with its tier, text, answer_schema, depends_on. Use FIRST to plan which tiers to walk.",
    inputSchema: { tier: z.number().int().nonnegative().optional() },
  },
  async (args): Promise<CallToolResult> => hListQuestions(session, args as any),
);

server.registerTool(
  "read_question",
  {
    description: "Return one question's full definition (text, answer_schema, retrieval_hints, depends_on).",
    inputSchema: { question_id: z.string() },
  },
  async (args): Promise<CallToolResult> => hReadQuestion(session, args as any),
);

server.registerTool(
  "set_question_answer",
  {
    description: [
      "Commit one QuestionAnswer. The platform coerces to the question's",
      "answer_schema (boolean/number/enum/string). Prefer `null` over",
      "guessing — the rule engine treats nulls as 'unknown'. Pass",
      "evidence (note_id + verbatim quote) when possible.",
    ].join(" "),
    inputSchema: {
      question_id: z.string(),
      answer: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      confidence: z.number().min(0).max(1).optional(),
      evidence: z.array(z.object({
        note_id: z.string(),
        quote: z.string(),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().nonnegative().optional(),
      })).optional(),
      reasoning: z.string().optional(),
      verifier_status: z.enum(["confirmed", "contradicted", "no_check"]).optional(),
    },
  },
  async (args): Promise<CallToolResult> => hSetQuestionAnswer(session, args as any),
);

server.registerTool(
  "get_adherence_state",
  {
    description: "Return the current review_state — which questions have been answered, their values, and the version counter.",
    inputSchema: {},
  },
  async (): Promise<CallToolResult> => hGetState(session),
);

server.registerTool(
  "set_review_status",
  {
    description: "Signal every question has been answered. The platform then runs the rule engine + LLM judge to produce rule_verdicts.",
    inputSchema: { status: z.literal("complete") },
  },
  async (args): Promise<CallToolResult> => hSetStatus(session, args as any),
);

server.registerTool(
  "list_notes",
  {
    description: "Return the patient's note metadata (filename, date, doctype). Use first to plan which notes to read.",
    inputSchema: {},
  },
  async (): Promise<CallToolResult> => hListNotes(session),
);

server.registerTool(
  "read_notes",
  {
    description: "Return N chart notes in one call. Pass filenames[] and optional max_chars_per_note (default 8192).",
    inputSchema: {
      filenames: z.array(z.string()).max(50),
      max_chars_per_note: z.number().int().positive().optional(),
    },
  },
  async (args): Promise<CallToolResult> => hReadNotes(session, args as any),
);

server.registerTool(
  "search_notes",
  {
    description: "Keyword search across the patient's notes. Pass queries[] (1-20 terms) — each matched case-insensitively as substring. Returns filename + offset + ±context snippet per hit. Cheaper than reading every note when you know the string to find (ACT, fluticasone, action plan, exacerbation). max_hits_per_query default 5, context_chars default 120.",
    inputSchema: {
      queries: z.array(z.string().min(1)).min(1).max(20),
      max_hits_per_query: z.number().int().positive().optional(),
      context_chars: z.number().int().positive().optional(),
    },
  },
  async (args): Promise<CallToolResult> => hSearchNotes(session, args as any),
);

server.registerTool(
  "list_structured_data",
  {
    description: "Return the OMOP tables available for this patient with row counts (conditions, drugs, measurements, observations, procedures, encounters). Use FIRST for any question with structured EHR signal — controller meds (drugs), ACT scores + spirometry (measurements), exacerbations (encounters). Empty tables → fall back to notes.",
    inputSchema: {},
  },
  async (): Promise<CallToolResult> => hListStructured(session),
);

server.registerTool(
  "read_structured_data",
  {
    description: "Read rows from one OMOP table by name (e.g. table='drugs'). Returns up to max_rows (default 200) rows verbatim. For asthma: drugs = controller + SABA history; measurements = ACT + spirometry; encounters = ED visits / hospitalizations driving exacerbation count.",
    inputSchema: {
      table: z.string(),
      max_rows: z.number().int().positive().optional(),
    },
  },
  async (args): Promise<CallToolResult> => hReadStructured(session, args as any),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[mcp-adherence-stdio] ready (patient=${patientId} task=${taskId} session=${sessionId})\n`,
  );
}
main().catch((e) => {
  process.stderr.write(`[mcp-adherence-stdio] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
