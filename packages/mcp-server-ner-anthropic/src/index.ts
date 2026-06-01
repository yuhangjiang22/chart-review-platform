// Anthropic Agent SDK adapter for the chart_review_ner MCP server.
//
// Parallel to @chart-review/mcp-server-anthropic — same shape, but the
// 7 NER tools instead of the 7 phenotype tools. The transport selector
// (`buildNerMcpServersConfig`) picks in-process vs stdio subprocess
// the same way the phenotype version does.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { guidelineDir } from "@chart-review/rubric";
import type { CompiledTask } from "@chart-review/tasks";
import { pathFor } from "@chart-review/storage";
import {
  listEntityTypes as hListEntityTypes,
  getConceptTree as hGetConceptTree,
  normalizeToOntology as hNormalize,
  locateInSource as hLocate,
  setSpanLabel as hSetSpanLabel,
  setSpanStatus as hSetSpanStatus,
  getSpanReviewState as hGetSpanReviewState,
  type CallToolResult, type NerMcpSession, type NerToolHooks, type NerReviewState,
} from "@chart-review/mcp-core-ner";

// Re-export the runtime types so callers (run-routes, pipeline-extract-ner)
// can construct sessions and hooks without a separate import path.
export type { NerMcpSession, NerToolHooks, NerReviewState };

// ── ontology resolution ──────────────────────────────────────────────

/**
 * Pick the concepts.json path for a task. Walks candidates in order and
 * returns the first one that exists on disk:
 *   1. Explicit `ontologyPath` argument (test / per-run override).
 *   2. `task.ontology_pin` of the form `<id>@<version>` — resolves to
 *      `pathFor.ontologySnapshot(id, version)` (locked / immutable).
 *   3. `<guidelineDir(task.task_id)>/references/ontology/concepts.json`
 *      — vendored inside the skill bundle (self-contained pre-lock).
 *   4. `CHART_REVIEW_NER_ONTOLOGY_PATH` env override.
 * Returns the first existent candidate, or the *last* candidate (which
 * the caller will fail to open with a clear ENOENT) if none exist —
 * deferring the error to the actual read site keeps this function
 * synchronous and predictable.
 */
export function resolveOntologyPath(
  task: CompiledTask,
  override?: string,
): string {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  const pin = (task as { ontology_pin?: string }).ontology_pin;
  if (pin && pin.includes("@")) {
    const [id, version] = pin.split("@");
    candidates.push(pathFor.ontologySnapshot(id!, version!));
  }
  candidates.push(path.join(
    guidelineDir(task.task_id),
    "references",
    "ontology",
    "concepts.json",
  ));
  const env = process.env.CHART_REVIEW_NER_ONTOLOGY_PATH;
  if (env) candidates.push(env);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[candidates.length - 1]!;
}

// ── in-process server (Anthropic SDK transport) ──────────────────────

export function makeNerMcpServer(
  patientId: string,
  task: CompiledTask,
  sessionId: string,
  hooks: NerToolHooks,
  opts: { ontologyPath?: string; reviewsRoot?: string } = {},
) {
  const session: NerMcpSession = {
    patientId,
    task,
    sessionId,
    ontologyPath: resolveOntologyPath(task, opts.ontologyPath),
    ...(opts.reviewsRoot ? { reviewsRoot: opts.reviewsRoot } : {}),
  };

  const listEntityTypes = tool(
    "list_entity_types",
    "Return the supported entity types — root labels of the ontology subtrees you may use as `entity_type` in subsequent calls. Always call this FIRST before normalizing or labeling spans, so you only emit entity_type values the ontology actually defines.",
    {},
    async (): Promise<CallToolResult> => hListEntityTypes(session),
  );

  const getConceptTree = tool(
    "get_concept_tree",
    "Return the ASCII tree of all concept_names under one entity_type. Use this to pick the MOST SPECIFIC concept_name that fits a span (don't default to the root unless no child fits).",
    { entity_type: z.string() },
    async (args): Promise<CallToolResult> => hGetConceptTree(session, args),
  );

  const normalizeToOntology = tool(
    "normalize_to_ontology",
    "Map a candidate surface label to a canonical concept_name. Precedence: exact → case-insensitive → underscore-normalized → substring candidates. When found=false and `alternatives` is populated, treat them as hints — pick one by calling this tool again with the chosen alternative as label, or tag the span status='novel_candidate' if none fit.",
    { entity_type: z.string(), label: z.string() },
    async (args): Promise<CallToolResult> => hNormalize(session, args),
  );

  const locateInSource = tool(
    "locate_in_source",
    "Resolve authoritative (start, end) byte offsets of a span in a note. Pass `note_id` (the patient's note file basename, without .txt) plus `anchor` (a verbatim substring of the note that contains your entity AND uniquely locates it) and `text` (the entity value to store). Always call this BEFORE set_span_label — character arithmetic from inspection is unreliable.",
    {
      note_id: z.string(),
      anchor: z.string(),
      text: z.string(),
    },
    async (args): Promise<CallToolResult> => hLocate(session, args),
  );

  const setSpanLabel = tool(
    "set_span_label",
    "Commit one entity span to the review state. The platform faithfulness-checks that source[start:end] === text and refuses the write if they disagree. start/end MUST come from locate_in_source; do not guess them.",
    {
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
    async (args): Promise<CallToolResult> => hSetSpanLabel(session, args, hooks),
  );

  const setSpanStatus = tool(
    "set_span_status",
    "Update an existing span's status (e.g. reviewer marks it rejected or promotes a novel_candidate to mapped). Identifies the span by its span_id.",
    {
      span_id: z.string(),
      status: z.enum(["mapped", "novel_candidate", "rejected"]),
      override_reason: z.string().optional(),
    },
    async (args): Promise<CallToolResult> => hSetSpanStatus(session, args, hooks),
  );

  const getSpanReviewState = tool(
    "get_span_review_state",
    "Return all currently-committed spans for this patient × task. Useful when the agent needs to inspect what it has already labeled to avoid duplicates.",
    {},
    async (): Promise<CallToolResult> => hGetSpanReviewState(session),
  );

  const all = {
    list_entity_types: listEntityTypes,
    get_concept_tree: getConceptTree,
    normalize_to_ontology: normalizeToOntology,
    locate_in_source: locateInSource,
    set_span_label: setSpanLabel,
    set_span_status: setSpanStatus,
    get_span_review_state: getSpanReviewState,
  };
  const subset = process.env.CHART_REVIEW_NER_MCP_TOOLS
    ? new Set(process.env.CHART_REVIEW_NER_MCP_TOOLS.split(",").map((s) => s.trim()))
    : null;
  const tools = Object.entries(all)
    .filter(([name]) => !subset || subset.has(name))
    .map(([, t]) => t);

  return createSdkMcpServer({
    name: "chart_review_ner",
    version: "0.1.0",
    tools,
  });
}

// ── transport selector ───────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STDIO_SERVER_PATH = path.join(
  __dirname,
  "..", "..", "mcp-server-ner-stdio", "src", "index.ts",
);

export interface BuildNerMcpServersOptions {
  reviewsRoot?: string;
  provider?: "claude" | "codex";
  ontologyPath?: string;
}

/**
 * Build the `mcpServers` config the Anthropic SDK consumes for a NER
 * agent run. Same transport-selector rules as the phenotype version:
 *   - MCP_TRANSPORT=subprocess or provider="codex" → spawn stdio subprocess
 *   - otherwise                                   → in-process registration
 */
export function buildNerMcpServersConfig(
  patientId: string,
  task: CompiledTask,
  sessionId: string,
  hooks: NerToolHooks,
  opts: BuildNerMcpServersOptions = {},
): Record<string, unknown> {
  const provider = opts.provider
    ?? ((process.env.AGENT_PROVIDER ?? "claude").toLowerCase() as "claude" | "codex");
  const wantsSubprocess =
    process.env.MCP_TRANSPORT === "subprocess" || provider === "codex";
  if (wantsSubprocess) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CHART_REVIEW_NER_PATIENT_ID: patientId,
      CHART_REVIEW_NER_TASK_ID: task.task_id,
      CHART_REVIEW_NER_SESSION_ID: sessionId,
      CHART_REVIEW_NER_ONTOLOGY_PATH: resolveOntologyPath(task, opts.ontologyPath),
    };
    if (opts.reviewsRoot) env.CHART_REVIEW_REVIEWS_ROOT = opts.reviewsRoot;
    return {
      chart_review_ner: {
        type: "stdio" as const,
        command: "npx",
        args: ["tsx", STDIO_SERVER_PATH],
        env,
      },
    };
  }
  return {
    chart_review_ner: makeNerMcpServer(patientId, task, sessionId, hooks, {
      reviewsRoot: opts.reviewsRoot,
      ontologyPath: opts.ontologyPath,
    }),
  };
}
