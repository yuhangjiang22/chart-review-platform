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
  listNotesTool as hListNotes,
  readNoteTool as hReadNote,
  getNoteSectionTool as hGetNoteSection,
  searchNotesTool as hSearchNotes,
  listCriteriaTool as hListCriteria,
  readCriterionTool as hReadCriterion,
  readNotesTool as hReadNotes,
  readCriteriaTool as hReadCriteria,
  listStructuredDataTool as hListStructuredData,
  readStructuredDataTool as hReadStructuredData,
  type CallToolResult,
  type McpSession,
} from "@chart-review/mcp-core";
import {
  listQuestions as hListQuestions,
  readQuestion as hReadQuestion,
  setQuestionAnswer as hSetQuestionAnswer,
  getAdherenceState as hGetAdherenceState,
} from "@chart-review/mcp-core-adherence";
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
        "When the field defines an enum (answer_schema), the answer must be",
        "EXACTLY one of those allowed values — off-enum free text is rejected.",
        "Map the finding to the closest allowed value, or use \"other\"/\"no_info\".",
        "For a NUMERIC SCALE field (answer_schema type integer/number, e.g. a",
        "MoCA/MMSE/NPI score): only answer with a number the chart actually",
        "documents, and cite the exact note span that contains that number —",
        "the platform rejects a numeric answer whose value is absent from the",
        "cited quote. If the chart documents NO value for the scale, set answer",
        "to null (do NOT write 0 or any placeholder — 0 is a real, severe score).",
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

// ── Read-side tools (PREFER OVER SHELL) ───────────────────────────────
// Codex agents otherwise shell out for every file read; these tools
// give them a typed alternative so file content doesn't get echoed
// through bash/sed into every subsequent turn's conversation history.

if (want("list_notes")) {
  server.registerTool(
    "list_notes",
    {
      description: [
        "PREFER OVER SHELL. Return the patient's note metadata (filename,",
        "date, doctype). Use this FIRST to discover which notes exist before",
        "reading them — do not `ls notes/` via shell.",
      ].join(" "),
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => hListNotes(session, {}),
  );
}

if (want("read_note")) {
  server.registerTool(
    "read_note",
    {
      description: [
        "PREFER OVER SHELL. Return the verbatim text of one chart note.",
        "Pagination: `max_chars` caps the slice (default 8192); `offset`",
        "lets you fetch a later window. Response includes `truncated` +",
        "`next_offset`. Do not `cat`/`sed` notes via shell — that echoes",
        "the entire file into the conversation history at every turn.",
      ].join(" "),
      inputSchema: {
        filename: z.string(),
        max_chars: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async (args): Promise<CallToolResult> => hReadNote(session, args as any),
  );
}

if (want("get_note_section")) {
  server.registerTool(
    "get_note_section",
    {
      description: [
        "PREFER OVER read_note for RUCAM. Returns the note header plus ONLY the",
        "rubric-relevant sections (Assessment, Plan, Impression, Diagnoses,",
        "Hospital Course, Labs, Medications, HPI, …) — much cheaper than reading",
        "the full note. Pass `sections` to override the default targets",
        "(case-insensitive substring match on the section name). Quotes pulled",
        "from a returned section still verify against the full note, so cite them",
        "as normal. Fall back to read_note (full text) only if the section you",
        "need is missing or the match looks ambiguous.",
      ].join(" "),
      inputSchema: {
        filename: z.string(),
        sections: z.array(z.string()).optional(),
      },
    },
    async (args): Promise<CallToolResult> => hGetNoteSection(session, args as any),
  );
}

if (want("search_notes")) {
  server.registerTool(
    "search_notes",
    {
      description: [
        "PREFER OVER SHELL grep. Case-insensitive substring search across ALL",
        "of the patient's notes. Returns {filename, offset, snippet} hits so you",
        "can jump to the relevant span on a long chart instead of reading every",
        "note. Use for high-signal terms ('final diagnosis', 'metastatic',",
        "'stage IV', 'M1', 'recurrence'), then read_note the best filename.",
      ].join(" "),
      inputSchema: {
        keyword: z.string().min(1),
        max_matches: z.number().int().positive().optional(),
        context_chars: z.number().int().nonnegative().optional(),
      },
    },
    async (args): Promise<CallToolResult> => hSearchNotes(session, args as any),
  );
}

// OMOP / structured-data read tools. Registered for any run that doesn't
// restrict the tool set via the CHART_REVIEW_MCP_TOOLS allowlist (`want()`
// allows everything when no subset is set) — so BOTH the phenotype agent
// (prompted to check structured data first, then fall back to notes) and
// adherence (whose questions reference OMOP tables: med lists, ACT scores,
// spirometry) get them. The adherence run further pins an explicit allowlist;
// phenotype passes none. Missing omop/ files resolve to empty tables (the
// handler returns {ok:true, tables:[]} / empty rows) — the agent falls back to
// notes rather than crashing.
if (want("list_structured_data")) {
  server.registerTool(
    "list_structured_data",
    {
      description: [
        "PREFER OVER SHELL. Return the patient's index_date (if the task uses",
        "one) plus the available OMOP structured-data tables and their row",
        "counts (conditions, drugs, measurements, observations, procedures,",
        "encounters). Call ONCE per session — early, before reading notes, if",
        "the task has a time-window rule — then read_structured_data the",
        "tables the questions reference. An empty tables list means this",
        "patient has no structured data — fall back to notes.",
      ].join(" "),
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => hListStructuredData(session, {}),
  );
}

if (want("read_structured_data")) {
  server.registerTool(
    "read_structured_data",
    {
      description: [
        "PREFER OVER SHELL. Return the rows of one OMOP structured-data table",
        "by name (from list_structured_data). `max_rows` caps the slice (default",
        "200). Use this for medication lists, ACT scores, spirometry values, and",
        "encounter history — it is cheaper and more accurate than scraping notes",
        "when the table is present. An unknown/empty table is reported, not fatal.",
      ].join(" "),
      inputSchema: {
        table: z.string(),
        max_rows: z.number().int().positive().optional(),
      },
    },
    async (args): Promise<CallToolResult> =>
      hReadStructuredData(session, args as any),
  );
}

// ── Adherence write/read tools (task_kind="adherence") ────────────────
// Gated on the task being an adherence task AND the run's allowlist. The
// agent commits one QuestionAnswer per question via set_question_answer
// (faithfulness-wrapped, like phenotype's set_field_assessment); the
// deterministic rule engine runs after the loop. Phenotype/NER tasks
// never reach this block (task_kind differs).
if (task.task_kind === "adherence") {
  if (want("list_questions")) {
    server.registerTool(
      "list_questions",
      {
        description: [
          "Return every question in the adherence framework: question_id, tier",
          "(0=eligibility, 1=control assessment, 2=management), answer_schema,",
          "depends_on, and retrieval_hints (which tells you WHERE to look —",
          "OMOP structured table vs notes). Call this FIRST (no args, or pass a",
          "`tier` to filter) to see what to answer.",
        ].join(" "),
        inputSchema: {
          tier: z.number().int().nonnegative().optional(),
        },
      },
      async (args): Promise<CallToolResult> =>
        hListQuestions(session, args as any),
    );
  }

  if (want("read_question")) {
    server.registerTool(
      "read_question",
      {
        description: [
          "Return one question's full definition (text, answer_schema,",
          "retrieval_hints, clinical rationale). Pass `question_id` (from",
          "list_questions). Use when you need the detailed guidance for a",
          "single question.",
        ].join(" "),
        inputSchema: {
          question_id: z.string(),
        },
      },
      async (args): Promise<CallToolResult> =>
        hReadQuestion(session, args as any),
    );
  }

  if (want("set_question_answer")) {
    server.registerTool(
      "set_question_answer",
      {
        description: [
          "PRIMARY WRITE. Commit your answer to ONE question in the adherence",
          "framework. Call once per question_id (from list_questions). The",
          "platform coerces `answer` to the question's answer_schema; pass null",
          "when the chart doesn't support an answer. Every NOTE evidence quote is",
          "faithfulness-checked — if a quote is not found verbatim in the cited",
          "note the call is rejected; do not invent quotes. Use find_quote_offsets",
          "or read_note to confirm the exact text first. The platform runs the",
          "rule engine AFTER your loop — you DO NOT compute rule verdicts yourself.",
        ].join(" "),
        inputSchema: {
          question_id: z.string(),
          answer: z.union([z.string(), z.number(), z.boolean(), z.null()]),
          confidence: z.number().min(0).max(1).optional(),
          evidence: z
            .array(
              z.object({
                note_id: z.string(),
                quote: z.string(),
                start: z.number().int().nonnegative().optional(),
                end: z.number().int().nonnegative().optional(),
              }),
            )
            .optional(),
          reasoning: z.string().optional(),
        },
      },
      async (args): Promise<CallToolResult> =>
        hSetQuestionAnswer(session, args as any),
    );
  }

  if (want("get_adherence_state")) {
    server.registerTool(
      "get_adherence_state",
      {
        description: [
          "Return the question_answers you have already committed for this",
          "patient×task, plus an answered_count. Use to check your progress",
          "before calling set_review_status.",
        ].join(" "),
        inputSchema: {},
      },
      async (): Promise<CallToolResult> => hGetAdherenceState(session),
    );
  }
}

if (want("list_criteria")) {
  server.registerTool(
    "list_criteria",
    {
      description: [
        "PREFER OVER SHELL. Return the list of rubric criterion field_ids",
        "for this task. Each entry has {field_id, filename}. Use this to",
        "discover what to assess — do not `ls criteria/` via shell.",
      ].join(" "),
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => hListCriteria(session, {}),
  );
}

if (want("read_criterion")) {
  server.registerTool(
    "read_criterion",
    {
      description: [
        "PREFER OVER SHELL. Return the verbatim definition of one rubric",
        "criterion .md file (prompt, schema, derivation rules, edge cases).",
        "Pass `field_id` (from list_criteria). Do not `cat`/`sed` criterion",
        "files via shell — `for f in *.md; do cat $f; done` dumps every byte",
        "into the conversation history.",
      ].join(" "),
      inputSchema: {
        field_id: z.string(),
      },
    },
    async (args): Promise<CallToolResult> => hReadCriterion(session, args as any),
  );
}

if (want("read_notes")) {
  server.registerTool(
    "read_notes",
    {
      description: [
        "Returns ONE chart note. Read notes one at a time — passing more than",
        "one filename is rejected. Batching every note into a single result",
        "overflows the model context (a multi-note dump triggers the runtime's",
        "large-tool-result offload, which the agent then can't page back).",
        "The entry includes total_chars, returned_chars, and a truncated flag",
        "(max_chars_per_note, default 8192).",
      ].join(" "),
      inputSchema: {
        // Capped at 1: a single oversized read_notes result is what overflows
        // the context window and trips deepagents' (broken, line-paged)
        // large-tool-result offload. One note per call keeps every tool
        // result small enough to stay inline.
        filenames: z.array(z.string()).min(1).max(1),
        max_chars_per_note: z.number().int().positive().optional(),
      },
    },
    async (args): Promise<CallToolResult> => hReadNotes(session, args as any),
  );
}

if (want("read_criteria")) {
  server.registerTool(
    "read_criteria",
    {
      description: [
        "PREFER OVER MULTIPLE read_criterion CALLS. Returns N rubric",
        "criterion definitions in a single tool result. Pass the list of",
        "field_ids (from list_criteria). This is the most efficient way to",
        "bootstrap on the rubric — one round-trip instead of one per criterion.",
      ].join(" "),
      inputSchema: {
        field_ids: z.array(z.string()).max(50),
      },
    },
    async (args): Promise<CallToolResult> => hReadCriteria(session, args as any),
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
