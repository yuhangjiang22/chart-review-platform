/**
 * In-process MCP server exposing the structured "update review state"
 * actions to the chat agent. The agent uses these instead of writing
 * the JSON file directly — every call goes through schema + faithfulness
 * validation, and the gateway is the only thing that persists state.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// CallToolResult is an internal MCP-SDK type that this package does not
// re-export; we shape the handler's return value to match its runtime
// expectation (an object with a `content` array of typed parts) and let
// the SDK adapter handle it.
type CallToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

import { findQuoteOffsetsImpl } from "./find-quote-offsets-impl.js";
import type { CompiledTask } from "./tasks.js";
import {
  applyUiAction,
  load as loadReviewState,
  loadOrCreate,
  type ReviewState,
  type UiAction,
} from "./domain/review/index.js";
import { appendAuditEntry } from "./audit-trail.js";
import { fieldApplicability, gateReferencedIds } from "./contract-eval.js";

export interface ReviewToolHooks {
  /** Called after every successful state mutation. Use it to broadcast. */
  onStateUpdate(state: ReviewState): void;
}

/**
 * Flat evidence schema. We DON'T use z.union of two object branches here
 * because Together-routed DeepSeek (and possibly other non-Anthropic
 * providers) reject the resulting `anyOf` at the parameter level with
 * "Input validation error". Instead, every field is optional and the
 * runtime discriminator (`source`) decides which fields are required.
 * `applySetAssessment` / `applySelectEvidence` re-validate the
 * source-specific shape after Zod accepts the flat input.
 */
const evidenceSchema = z.object({
  source: z.enum(["note", "omop", "structured"]),

  // note fields
  note_id: z.string().optional(),
  span_offsets: z
    .array(z.number().int().nonnegative())
    .length(2)
    .optional(),
  verbatim_quote: z.string().optional(),
  doc_type: z.string().optional(),
  author_role: z.string().optional(),

  // omop / structured fields
  table: z.string().optional(),
  row_id: z.string().optional(), // pass numeric row_ids stringified
  concept_id: z.number().int().optional(),
  concept_name: z.string().optional(),
  value: z.unknown().optional(),
  unit: z.string().optional(),

  // common
  evidence_date: z.string().optional(),
});

/**
 * Validate every evidence row's source-specific shape and return them
 * unchanged. Used by handlers that take an evidence array (or a single
 * evidence) before constructing a UiAction.
 */
function validatedEvidence<T extends Array<any> | undefined>(arr: T): T {
  if (!arr) return arr;
  for (const ev of arr as any[]) ensureEvidenceShape(ev);
  return arr;
}

/**
 * Funnel every chat-agent action through one applyUiAction call. Returns
 * a CallToolResult shaped for the SDK; emits a ui_action audit entry
 * keyed to this session. Errors are translated to `{ok:false, ...}`
 * payloads so the model can read them and try again.
 */
async function runAction(
  patientId: string,
  task: CompiledTask,
  sessionId: string,
  hooks: ReviewToolHooks,
  action: UiAction,
  payloadSummary: () => string,
): Promise<CallToolResult> {
  try {
    const result = applyUiAction(
      patientId,
      task,
      "agent",
      `agent_${sessionId}`,
      action,
    );
    appendAuditEntry(
      { patientId, taskId: task.task_id, sessionId },
      {
        ts: new Date().toISOString(),
        session_id: sessionId,
        step_type: "ui_action",
        action_type: action.type,
        source: "agent",
        payload_summary: payloadSummary(),
        result_version: result.state.version,
        added_evidence_id: result.added_evidence_id,
        ...(action.type === "set_field_assessment" && {
          payload_field_id: (action.payload as { field_id?: string }).field_id,
          payload_answer: (action.payload as { answer?: unknown }).answer,
        }),
      },
    );
    hooks.onStateUpdate(result.state);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            action_type: action.type,
            version: result.state.version,
            warnings: result.warnings,
            added_evidence_id: result.added_evidence_id,
          }),
        },
      ],
    };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "error";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            action_type: action.type,
            error_code: code,
            message: (e as Error).message,
          }),
        },
      ],
    };
  }
}

/** Runtime discriminator. Throws ReviewStateError-equivalent if shape is wrong. */
function ensureEvidenceShape(ev: any): asserts ev is {
  source: "note" | "omop" | "structured";
  [k: string]: unknown;
} {
  if (!ev || typeof ev !== "object" || !ev.source) {
    throw new Error("evidence missing");
  }
  if (ev.source === "note") {
    if (
      typeof ev.note_id !== "string" ||
      !Array.isArray(ev.span_offsets) ||
      ev.span_offsets.length !== 2 ||
      typeof ev.verbatim_quote !== "string" ||
      ev.verbatim_quote.length === 0
    ) {
      throw new Error(
        "note evidence requires note_id, span_offsets [start,end], and verbatim_quote",
      );
    }
  } else if (ev.source === "omop" || ev.source === "structured") {
    if (typeof ev.table !== "string" || ev.row_id === undefined) {
      throw new Error("omop/structured evidence requires table and row_id");
    }
  }
}

/**
 * Commit gate: before the agent transitions to `agent_complete`, verify that
 * every rubric criterion that is applicable has an entry in field_assessments.
 *
 * Criteria with `is_applicable_when` that evaluates to `not_applicable` given
 * the current answers are exempt — they don't need an assessment.
 * Derived criteria (has `derivation`) are also exempt.
 *
 * Returns `null` on success, or an object `{ missing_criteria: string[] }` on
 * failure.
 */
export function checkCommitGate(
  task: CompiledTask,
  state: ReviewState,
): { missing_criteria: string[]; unanswered_gate_deps?: string[] } | null {
  // Build an env mapping field_id → answer from current assessments.
  const answers: Record<string, unknown> = {};
  for (const fa of state.field_assessments) {
    answers[fa.field_id] = fa.answer;
  }

  const missing: string[] = [];
  // Collect the field IDs that gate expressions depend on but have not been
  // answered yet. These are the root cause when applicability === "unknown".
  const unansweredGateDeps = new Set<string>();

  for (const field of task.fields) {
    // Derived fields are computed, not asserted — skip.
    if (field.derivation) continue;

    // Check applicability gate.
    if (field.is_applicable_when) {
      const applicability = fieldApplicability(task, answers, field.id);
      // If the gate evaluates to not_applicable, this field is exempt.
      if (applicability === "not_applicable") continue;
      // If gate is "unknown" (dependencies not yet answered), walk the gate's
      // referenced field IDs and collect the ones that are missing an answer.
      // We surface THOSE as the root-cause, not the gated field itself.
      if (applicability === "unknown") {
        const deps = gateReferencedIds(task, field.id);
        for (const dep of deps) {
          if (answers[dep] === undefined) {
            unansweredGateDeps.add(dep);
          }
        }
        // The gated field itself is still required (the gate couldn't be
        // evaluated), so fall through to the hasAssessment check below.
      }
    }

    // Check if field has an assessment.
    const hasAssessment = state.field_assessments.some(
      (fa) => fa.field_id === field.id,
    );
    if (!hasAssessment) {
      missing.push(field.id);
    }
  }

  if (missing.length === 0) return null;
  const result: { missing_criteria: string[]; unanswered_gate_deps?: string[] } = { missing_criteria: missing };
  if (unansweredGateDeps.size > 0) {
    result.unanswered_gate_deps = [...unansweredGateDeps];
  }
  return result;
}

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
  // Touch the file so loadOrCreate fires once per session.
  loadOrCreate(patientId, task);

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
    async (args): Promise<CallToolResult> => {
      // override_of_agent is a UI hint indicating the agent meant to override.
      // It is logged in the audit summary for traceability, but NOT passed to
      // applySetAssessment — the server-authoritative capture predicate (spec §5.5)
      // decides snapshot capture from persisted state alone.
      const { override_of_agent, ...payload } = args;
      return runAction(
        patientId,
        task,
        sessionId,
        hooks,
        {
          type: "set_field_assessment",
          payload: {
            ...payload,
            evidence: validatedEvidence(payload.evidence),
          } as any,
        },
        () =>
          `field_id=${args.field_id}${override_of_agent ? " override_of_agent=true" : ""}`,
      );
    },
  );

  const getReviewState = tool(
    "get_review_state",
    "Return the current review state for this patient×task.",
    {},
    async (): Promise<CallToolResult> => {
      const state = loadReviewState(patientId, task.task_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(state ?? { field_assessments: [] }),
          },
        ],
      };
    },
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
    async (args): Promise<CallToolResult> => {
      return runAction(
        patientId,
        task,
        sessionId,
        hooks,
        { type: "set_summary", payload: args },
        () => `keys=${Object.keys(args).join(",")}`,
      );
    },
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
    async (args): Promise<CallToolResult> => {
      return runAction(
        patientId,
        task,
        sessionId,
        hooks,
        { type: "recommend_keywords", payload: args },
        () => `topic=${args.topic}`,
      );
    },
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
      category: z
        .enum(["supporting", "contradicting", "context"])
        .optional(),
      field_id: z
        .string()
        .optional()
        .describe(
          "Optional protocol field this evidence speaks to (e.g. 'pathology_report_present').",
        ),
    },
    async (args): Promise<CallToolResult> => {
      return runAction(
        patientId,
        task,
        sessionId,
        hooks,
        {
          type: "select_evidence",
          payload: {
            ...args,
            evidence: validatedEvidence([args.evidence])[0],
          } as any,
        },
        () =>
          `category=${args.category ?? "(none)"} note=${(args.evidence as any).note_id ?? (args.evidence as any).table}`,
      );
    },
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
    async (args): Promise<CallToolResult> => {
      const r = findQuoteOffsetsImpl(patientId, args.note_id, args.snippet);
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(r) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(r) }],
      };
    },
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
    async (_args): Promise<CallToolResult> => {
      // Load current state to run the commit gate against it.
      const state = loadReviewState(patientId, task.task_id);
      if (!state) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error_code: "state_not_found",
                message: "Review state not found. Call set_field_assessment at least once first.",
              }),
            },
          ],
        };
      }

      const gateResult = checkCommitGate(task, state);
      if (gateResult) {
        const depHint =
          gateResult.unanswered_gate_deps && gateResult.unanswered_gate_deps.length > 0
            ? ` Some criteria could not be evaluated because their gate dependencies (${gateResult.unanswered_gate_deps.join(", ")}) have not been answered yet — answer those leaf criteria first.`
            : "";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error_code: "incomplete_review",
                message: `Cannot mark review complete: ${gateResult.missing_criteria.length} criterion/criteria have no committed value. Commit values for every criterion before calling set_review_status.${depHint}`,
                missing_criteria: gateResult.missing_criteria,
                ...(gateResult.unanswered_gate_deps
                  ? { unanswered_gate_deps: gateResult.unanswered_gate_deps }
                  : {}),
              }),
            },
          ],
        };
      }

      return runAction(
        patientId,
        task,
        sessionId,
        hooks,
        {
          type: "set_review_status",
          payload: { review_status: "agent_complete" },
        },
        () => "status=agent_complete",
      );
    },
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
    version: "0.5.0",
    tools,
  });
}
