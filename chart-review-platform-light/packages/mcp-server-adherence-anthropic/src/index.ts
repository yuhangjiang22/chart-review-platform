// In-process Anthropic SDK adapter for chart_review_adherence.
//
// Parallel to:
//   mcp-server-anthropic       → chart_review_state    (phenotype)
//   mcp-server-ner-anthropic   → chart_review_ner      (NER)
//
// Adherence agent calls these tools during the agent loop to:
//   1. Discover the question framework (list_questions, read_question)
//   2. Read the chart (list_notes, read_notes)
//   3. Commit one answer per question (set_question_answer)
//   4. Signal completion (set_review_status)
// The platform's post-agent rule-engine pass produces rule_verdicts.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CompiledTask } from "@chart-review/tasks";
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

export function makeAdherenceMcpServer(
  patientId: string,
  task: CompiledTask,
  sessionId: string,
) {
  const session: AdherenceMcpSession = { patientId, task, sessionId };

  const listQuestions = tool(
    "list_questions",
    "Return the adherence task's question framework — every question_id with its tier, text, answer_schema, depends_on. Use this FIRST to plan which tiers to walk and what schemas to honor when answering.",
    { tier: z.number().int().nonnegative().optional() },
    async (args): Promise<CallToolResult> => hListQuestions(session, args),
  );

  const readQuestion = tool(
    "read_question",
    "Return one question's full definition (text, answer_schema, retrieval_hints, depends_on). Use when you need the full prompt + schema before committing an answer.",
    { question_id: z.string() },
    async (args): Promise<CallToolResult> => hReadQuestion(session, args),
  );

  const setQuestionAnswer = tool(
    "set_question_answer",
    [
      "Commit one QuestionAnswer for this patient × task. The platform",
      "coerces the answer to match the question's answer_schema (boolean,",
      "number, enum, string). If the value doesn't fit the schema it is",
      "stored as null. Prefer `null` over guessing — the rule engine",
      "downstream treats nulls as 'unknown' rather than as a wrong answer.",
      "Pass `evidence` as note_id + verbatim quote pairs whenever possible.",
    ].join(" "),
    {
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
    async (args): Promise<CallToolResult> => hSetQuestionAnswer(session, args),
  );

  const getAdherenceState = tool(
    "get_adherence_state",
    "Return the current review_state for this patient × task: which questions have been answered, their values, and the version counter.",
    {},
    async (): Promise<CallToolResult> => hGetState(session),
  );

  const setReviewStatus = tool(
    "set_review_status",
    "Signal that every question has been answered. Marks review_status='agent_complete'. The platform runs the deterministic rule engine + nuanced LLM judge afterwards to produce rule_verdicts.",
    { status: z.literal("complete") },
    async (args): Promise<CallToolResult> => hSetStatus(session, args),
  );

  const listNotes = tool(
    "list_notes",
    "Return the patient's note metadata (filename, date, doctype). Use first to plan which notes to read.",
    {},
    async (): Promise<CallToolResult> => hListNotes(session),
  );

  const readNotes = tool(
    "read_notes",
    "Return N chart notes in one call. Pass filenames[] and optional max_chars_per_note (default 8192). Pagination: each entry includes total_chars/returned_chars/truncated.",
    {
      filenames: z.array(z.string()).max(50),
      max_chars_per_note: z.number().int().positive().optional(),
    },
    async (args): Promise<CallToolResult> => hReadNotes(session, args),
  );

  const searchNotes = tool(
    "search_notes",
    "Keyword search across this patient's notes. Pass queries[] (1-20 terms) — each is matched case-insensitively as a substring. Returns matches with filename + character offset + ±context snippet so you can read_notes on the right file. Use this BEFORE read_notes when you know what string to find (e.g. 'ACT', 'fluticasone', 'action plan', 'exacerbation'). Cheaper and more accurate than reading every note. max_hits_per_query default 5, context_chars default 120.",
    {
      queries: z.array(z.string().min(1)).min(1).max(20),
      max_hits_per_query: z.number().int().positive().optional(),
      context_chars: z.number().int().positive().optional(),
    },
    async (args): Promise<CallToolResult> => hSearchNotes(session, args),
  );

  const listStructuredData = tool(
    "list_structured_data",
    "Return the available OMOP-style structured tables for this patient with row counts: conditions, drugs, measurements, observations, procedures, encounters. Use FIRST when answering questions that have structured EHR signal — ACT scores (measurements), controller meds (drugs), exacerbations (encounters + drugs), spirometry (measurements). Empty tables → fall back to notes.",
    {},
    async (): Promise<CallToolResult> => hListStructured(session),
  );

  const readStructuredData = tool(
    "read_structured_data",
    "Read rows from one structured table by name (e.g. table='drugs'). Returns up to max_rows (default 200) rows verbatim. Each row has standard OMOP fields (code, code_system, label, value/dose/quantity/date as applicable). For asthma adherence: drugs table is the source of truth for controller prescriptions + SABA refill cadence; measurements for ACT score + spirometry; encounters for ED visits driving exacerbation counts.",
    {
      table: z.string(),
      max_rows: z.number().int().positive().optional(),
    },
    async (args): Promise<CallToolResult> => hReadStructured(session, args),
  );

  return createSdkMcpServer({
    name: "chart_review_adherence",
    version: "0.1.0",
    tools: [
      listQuestions, readQuestion, setQuestionAnswer,
      getAdherenceState, setReviewStatus,
      listNotes, readNotes, searchNotes,
      listStructuredData, readStructuredData,
    ],
  });
}

// Subprocess transport entry point — paired with mcp-server-adherence-stdio.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = path.resolve(
  __dirname, "..", "..", "mcp-server-adherence-stdio", "src", "index.ts",
);

export interface BuildAdherenceMcpServersOptions {
  reviewsRoot?: string;
  provider?: "claude" | "codex";
}

export function buildAdherenceMcpServersConfig(
  patientId: string,
  task: CompiledTask,
  sessionId: string,
  opts: BuildAdherenceMcpServersOptions = {},
): Record<string, unknown> {
  const provider = opts.provider
    ?? ((process.env.AGENT_PROVIDER ?? "claude").toLowerCase() as "claude" | "codex");
  const wantsSubprocess =
    process.env.MCP_TRANSPORT === "subprocess" || provider === "codex";
  if (wantsSubprocess) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CHART_REVIEW_ADH_PATIENT_ID: patientId,
      CHART_REVIEW_ADH_TASK_ID: task.task_id,
      CHART_REVIEW_ADH_SESSION_ID: sessionId,
    };
    if (opts.reviewsRoot) env.CHART_REVIEW_REVIEWS_ROOT = opts.reviewsRoot;
    return {
      chart_review_adherence: {
        type: "stdio" as const,
        command: "npx",
        args: ["tsx", STDIO_SERVER_PATH],
        env,
      },
    };
  }
  return {
    chart_review_adherence: makeAdherenceMcpServer(patientId, task, sessionId),
  };
}
