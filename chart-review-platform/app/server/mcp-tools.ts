/**
 * Anthropic-SDK adapter for the chart_review_state MCP tools.
 *
 * The handler bodies live in mcp-handlers.ts as pure functions; this
 * file wraps each one with @anthropic-ai/claude-agent-sdk's `tool()`
 * helper and assembles them into an in-process server via
 * `createSdkMcpServer()`. A separate adapter at app/mcp-server/index.ts
 * exposes the same handlers via stdio for non-Anthropic providers.
 *
 * Keep this file thin — every behavior change should land in
 * mcp-handlers.ts so both adapters benefit.
 */

import path from "path";
import { fileURLToPath } from "url";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { CompiledTask } from "./tasks.js";
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
  checkCommitGate as hCheckCommitGate,
  type CallToolResult,
  type McpSession,
  type ReviewToolHooks,
} from "./mcp-handlers.js";

// Re-exports for callers that previously imported these from mcp-tools.
export type { ReviewToolHooks };
export const checkCommitGate = hCheckCommitGate;

/**
 * Build a fresh MCP server bound to one patient×task. Each chat session
 * gets its own server so the patient_id / task_id are closed-over and
 * the agent cannot accidentally write into another patient's review.
 */
export function makeReviewMcpServer(
  patientId: string,
  task: CompiledTask,
  sessionId: string,
  hooks: ReviewToolHooks,
) {
  const session: McpSession = { patientId, task, sessionId };
  initSession(session);

  const setFieldAssessment = tool(
    "set_field_assessment",
    [
      "Record an answer for one protocol field on the current patient.",
      "The platform validates the field_id against the compiled task and",
      "runs a faithfulness pre-check on every cited note quote. If the",
      "offsets do not resolve to the verbatim_quote in the source note,",
      "the call is rejected — do not invent quotes or guess offsets.",
    ].join(" "),
    {
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
    async (args): Promise<CallToolResult> =>
      hSetFieldAssessment(session, args, hooks),
  );

  const getReviewState = tool(
    "get_review_state",
    "Return the current review state for this patient×task.",
    {},
    async (): Promise<CallToolResult> => hGetReviewState(session),
  );

  const setSummary = tool(
    "set_summary",
    [
      "Record a brief chart summary on the current patient×task.",
      "Use this when the reviewer asks you to summarize the chart;",
      "the platform persists it and the UI surfaces it at the top of",
      "the Review Form pane. Keep brief_summary to 4–6 sentences,",
      "key_conditions to the 3–6 most relevant active diagnoses, and",
      "uncertainties to anything the chart leaves ambiguous.",
    ].join(" "),
    {
      brief_summary: z.string().optional(),
      key_conditions: z.array(z.string()).optional(),
      uncertainties: z.array(z.string()).optional(),
      evidence_files: z.array(z.string()).optional(),
    },
    async (args): Promise<CallToolResult> =>
      hSetSummary(session, args, hooks),
  );

  const recommendKeywords = tool(
    "recommend_keywords",
    [
      "Surface a clinically-aware keyword expansion the reviewer can use",
      "as note-search terms. Always include direct_terms (canonical names),",
      "abbreviations (acronyms a clinician might write), aliases (other ways",
      "the same thing is documented), behavioral_clues (descriptive language",
      "that implies the topic without naming it), treatment_terms (drugs and",
      "interventions specific to the topic), and negation_patterns (phrases",
      "that explicitly RULE OUT the topic — search the reviewer should know",
      "to suppress).",
    ].join(" "),
    {
      topic: z.string(),
      direct_terms: z.array(z.string()).optional(),
      aliases: z.array(z.string()).optional(),
      abbreviations: z.array(z.string()).optional(),
      behavioral_clues: z.array(z.string()).optional(),
      treatment_terms: z.array(z.string()).optional(),
      negation_patterns: z.array(z.string()).optional(),
    },
    async (args): Promise<CallToolResult> =>
      hRecommendKeywords(session, args, hooks),
  );

  const selectEvidence = tool(
    "select_evidence",
    [
      "Flag a noteworthy passage in the chart for the reviewer. Use this",
      "when you find supporting OR contradicting evidence the reviewer",
      "should see, even if it is not yet tied to a specific protocol",
      "field. Pass either a note evidence (note_id + span_offsets +",
      "verbatim_quote) or an omop evidence (table + row_id + …). The",
      "platform faithfulness-checks note offsets before persisting and",
      "the UI shows the entry as a clickable card; clicking jumps to",
      "the source note and highlights the span.",
    ].join(" "),
    {
      evidence: evidenceSchema,
      rationale: z.string().optional(),
      category: z.enum(["supporting", "contradicting", "context"]).optional(),
      field_id: z
        .string()
        .optional()
        .describe(
          "Optional protocol field this evidence speaks to (e.g. 'pathology_report_present').",
        ),
    },
    async (args): Promise<CallToolResult> =>
      hSelectEvidence(session, args, hooks),
  );

  const findQuoteOffsets = tool(
    "find_quote_offsets",
    [
      "Locate a snippet inside one of this patient's notes and return",
      "its exact character offsets. Use this BEFORE calling select_evidence",
      "or set_field_assessment with note evidence — feed the snippet you",
      "want to cite, get back the exact span_offsets, then pass those",
      "offsets verbatim to the assessment / evidence call. This avoids the",
      "faithfulness gate rejecting hand-counted offsets.",
      "Whitespace-tolerant: the snippet's whitespace can differ from the",
      "note's; the platform finds the match either way.",
    ].join(" "),
    {
      note_id: z
        .string()
        .describe(
          "Filename in this patient's notes/ directory, with or without the .txt extension.",
        ),
      snippet: z
        .string()
        .describe(
          "The text you want to cite. Copy verbatim from a Read result; whitespace differences are tolerated.",
        ),
    },
    async (args): Promise<CallToolResult> => hFindQuoteOffsets(session, args),
  );

  const setReviewStatus = tool(
    "set_review_status",
    [
      "Signal that the agent has finished reviewing this patient and all",
      "rubric criteria have been committed via set_field_assessment.",
      "The only accepted value for `status` is 'complete'. The platform",
      "enforces a commit gate: every non-derived, applicable criterion must",
      "have a field_assessment before this call will succeed. If any criteria",
      "are missing, the call returns an error with code 'incomplete_review'",
      "and a list of the missing field_ids — commit those first, then retry.",
    ].join(" "),
    {
      status: z
        .literal("complete")
        .describe("Must be 'complete'. The only value the agent may set."),
    },
    async (_args): Promise<CallToolResult> =>
      hSetReviewStatus(session, hooks),
  );

  // The full set, keyed by short name. CHART_REVIEW_MCP_TOOLS env var
  // lets us subset what's actually registered (and therefore sent to the
  // provider in the tool-definitions payload). Useful when a non-Anthropic
  // provider on OpenRouter rejects parts of the full schema; default is
  // all seven tools enabled.
  const all = {
    set_field_assessment: setFieldAssessment,
    get_review_state: getReviewState,
    set_summary: setSummary,
    recommend_keywords: recommendKeywords,
    select_evidence: selectEvidence,
    find_quote_offsets: findQuoteOffsets,
    set_review_status: setReviewStatus,
  };
  const subset = process.env.CHART_REVIEW_MCP_TOOLS
    ? new Set(
        process.env.CHART_REVIEW_MCP_TOOLS.split(",").map((s) => s.trim()),
      )
    : null;
  const tools = Object.entries(all)
    .filter(([name]) => !subset || subset.has(name))
    .map(([, t]) => t);

  return createSdkMcpServer({
    name: "chart_review_state",
    version: "0.6.0",
    tools,
  });
}

// ── transport selector ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STDIO_SERVER_PATH = path.join(__dirname, "mcp-stdio-server.ts");

/** Optional overrides the call site needs to flow into the subprocess
 *  env vars. The most important one is `reviewsRoot` — the parent
 *  process uses `withReviewsRoot()` AsyncLocalStorage to redirect
 *  writes to a scratch directory during a single agent run, but
 *  AsyncLocalStorage doesn't cross process boundaries. The subprocess
 *  has to be told about the redirect explicitly via the
 *  CHART_REVIEW_REVIEWS_ROOT env var. */
export interface BuildMcpServersOptions {
  /** Per-run override for the reviews root. The subprocess will
   *  receive this as CHART_REVIEW_REVIEWS_ROOT, which review-state.ts
   *  honors (taking precedence over the default
   *  `<PLATFORM_ROOT>/reviews/`). */
  reviewsRoot?: string;
  /** Per-run agent provider — when "codex", forces subprocess MCP
   *  transport regardless of MCP_TRANSPORT env var. Falls back to
   *  AGENT_PROVIDER env var when omitted. */
  provider?: "claude" | "codex";
}

/**
 * Build the `mcpServers` config the Anthropic SDK consumes for an
 * agent run. Picks transport based on the `MCP_TRANSPORT` env var:
 *
 *   - `MCP_TRANSPORT=subprocess` → spawn the standalone stdio server
 *     at app/server/mcp-stdio-server.ts. Required for non-Anthropic
 *     providers (Codex, Ollama, etc.) and useful for testing.
 *
 *   - any other value (default) → in-process registration via
 *     `makeReviewMcpServer()` — current behavior.
 *
 * The session context (patientId, task, sessionId) is captured the
 * same way in both transports — closures for in-process, env vars
 * for subprocess.
 *
 * Note: subprocess transport ignores `hooks.onStateUpdate`. The
 * subprocess can't broadcast WebSocket events back to the parent;
 * instead, the main server picks up state changes by reading the
 * filesystem on its next polling cycle. For batch agent runs (where
 * Studio polls `/api/runs/...` every few seconds anyway) this is
 * functionally equivalent.
 */
export function buildMcpServersConfig(
  patientId: string,
  task: CompiledTask,
  sessionId: string,
  hooks: ReviewToolHooks,
  opts: BuildMcpServersOptions = {},
): Record<string, unknown> {
  // Codex (and any future non-Anthropic provider) can't host an
  // in-process Anthropic-SDK server, so subprocess transport is the
  // only viable shape. Auto-promote when the active provider demands
  // it, even if the operator didn't set MCP_TRANSPORT explicitly.
  // The per-run override (opts.provider) wins over the env var so a
  // single server can host runs from both providers.
  const provider = opts.provider
    ?? ((process.env.AGENT_PROVIDER ?? "claude").toLowerCase() as "claude" | "codex");
  const wantsSubprocess =
    process.env.MCP_TRANSPORT === "subprocess" || provider === "codex";
  if (wantsSubprocess) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CHART_REVIEW_MCP_PATIENT_ID: patientId,
      CHART_REVIEW_MCP_TASK_ID: task.task_id,
      CHART_REVIEW_MCP_SESSION_ID: sessionId,
    };
    // The reviewsRoot override is what makes the per-run scratch
    // directory work across the process boundary. Without it, the
    // subprocess writes to <PLATFORM_ROOT>/reviews/ and runs.ts's
    // post-run check (looking at scratchRoot) sees nothing, failing
    // with "did not write review_state.json".
    if (opts.reviewsRoot) {
      env.CHART_REVIEW_REVIEWS_ROOT = opts.reviewsRoot;
    }
    return {
      chart_review_state: {
        type: "stdio" as const,
        command: "npx",
        args: ["tsx", STDIO_SERVER_PATH],
        env,
      },
    };
  }
  return {
    chart_review_state: makeReviewMcpServer(patientId, task, sessionId, hooks),
  };
}
