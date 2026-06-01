// Real ExtractModule — wraps v1's runAgent and builds the same agent
// context v1's batch-run driver builds before each call.
//
// What "the same context" means concretely:
//   - cwd = patientDir(subject.id)       — agent's working dir is the patient's note dir
//   - guidelinePath = guidelineDir(taskId) — points at the active skill bundle so
//                                             chart-review + chart-review-<task>-phenotype
//                                             skills activate via Claude SDK's walk-up
//   - mcpServers = profile.buildMcpServers(...) — phenotype profile uses
//                                                  buildMcpServersConfig (7 chart_review_state
//                                                  tools); NER profile uses the NER MCP server.
//   - hooks = buildAuditHooks(...)        — every tool call captured to v1's audit-trail
//   - extraSystemPrompt                   — built per-profile (phenotype batch-mode framing vs NER)
//   - withReviewsRoot wrap                — redirects MCP writes into v2's reviewsRoot
//
// The `ExtractorProfile` parameter is the seam that lets NER and any future
// task_kind plug in without duplicating the SDK plumbing. Phenotype keeps
// the old behavior via the default profile.

import path from "node:path";
import type {
  ExtractModule, ExtractorOutput, FormSpec,
  SubjectRef, EvidenceUnit, ProviderName,
} from "@chart-review/v2-shared";
import { runAgent } from "@chart-review/agent-provider";
import { patientDir } from "@chart-review/patients";
import { guidelineDir } from "@chart-review/rubric";
import { loadCompiledTask, type CompiledTask } from "@chart-review/tasks";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import { buildAuditHooks } from "@chart-review/audit-trail";
import { withReviewsRoot } from "@chart-review/domain-review";

/** Context handed to every profile callback. Kept minimal so profiles
 *  don't reach back into the extractor's internals. */
export interface ExtractorProfileContext {
  form: FormSpec;
  subject: SubjectRef;
  corpus: EvidenceUnit[];
  task: CompiledTask;
  sessionId: string;
  scratchRoot: string;
  provider?: ProviderName;
}

/**
 * An extractor profile: the three task-kind-specific pieces of an agent
 * extraction. Phenotype tasks use `defaultPhenotypeProfile`; NER tasks
 * pass a profile that builds the NER MCP server, a different prompt, and
 * reads `span_labels` out of scratch state. New task kinds plug in by
 * supplying a third profile — no edits to this file needed.
 */
export interface ExtractorProfile {
  /** Profile id for logging / debug. */
  id: string;
  /** Build the MCP servers map handed to runAgent. Phenotype profile
   *  returns the chart_review_state server; NER profile returns the
   *  ner_state server. */
  buildMcpServers(ctx: ExtractorProfileContext): Record<string, unknown>;
  /** Build the user-facing batch prompt the agent receives. */
  buildPrompt(ctx: ExtractorProfileContext): string;
  /** Build the system-prompt suffix appended by `runAgent`. */
  buildExtraSystemPrompt(ctx: ExtractorProfileContext): string;
  /** Read the agent's output out of scratch state once the run finishes.
   *  Returns the shape `ExtractorOutput` expects — phenotype populates
   *  `cells`, NER populates `spans`. */
  readScratchOutput(
    ctx: ExtractorProfileContext,
  ): Promise<{ cells: ExtractorOutput["cells"]; spans?: ExtractorOutput["spans"] }>;
}

export interface V1AgentExtractOptions {
  /** Provider override; falls back to AGENT_PROVIDER env var. */
  provider?: ProviderName;
  /** Per-call model override (e.g., "anthropic/claude-sonnet-4.6"). */
  model?: string;
  /** Where MCP-written drafts should land. The agent's `set_field_assessment`
   *  calls write to <reviewsRoot>/<patient>/<task>/review_state.json; the
   *  pipeline then renames that into per_patient/<pid>/agents/<id>.json. */
  reviewsRoot: string;
  maxTurns?: number;
  /** Profile that supplies task-kind-specific pieces (MCP servers, prompt,
   *  output reader). Defaults to the phenotype profile so callers that
   *  don't know about profiles keep their existing behavior. */
  profile?: ExtractorProfile;
}

export function makeV1AgentExtract(opts: V1AgentExtractOptions): ExtractModule {
  const profile = opts.profile ?? defaultPhenotypeProfile;
  return {
    async extract(
      form: FormSpec,
      subject: SubjectRef,
      corpus: EvidenceUnit[],
      extractor_id: string,
    ): Promise<ExtractorOutput> {
      const task = loadCompiledTask(form.task_id);
      if (!task) {
        throw new Error(`extract: no compiled task for ${form.task_id}`);
      }

      // Per-extractor scratch dir so multiple extractors writing the
      // same (patient, task) don't clobber each other.
      const scratchRoot = path.join(opts.reviewsRoot, "_scratch", extractor_id);
      const sessionId = `v2-${extractor_id}-${subject.id}-${Date.now()}`;

      const ctx: ExtractorProfileContext = {
        form, subject, corpus, task, sessionId, scratchRoot,
        provider: opts.provider,
      };

      // The audit hooks v1 uses: every tool_call_pre / tool_call_post
      // lands in v1's audit-trail JSONL.
      const auditHooks = buildAuditHooks({
        patientId: subject.id,
        taskId: form.task_id,
        sessionId,
      });
      const sdkHooks: Record<string, Array<{ hooks: any[] }>> = {
        PreToolUse: [{ hooks: [auditHooks.pre] }],
        PostToolUse: [{ hooks: [auditHooks.post] }],
      };

      const mcpServers = profile.buildMcpServers(ctx);
      const cwd = patientDir(subject.id);
      const userPrompt = profile.buildPrompt(ctx);

      // withReviewsRoot routes the in-process MCP writes' AsyncLocalStorage
      // lookup to scratchRoot for the duration of this for-await.
      await withReviewsRoot(scratchRoot, async () => {
        for await (const _event of runAgent({
          prompt: userPrompt,
          cwd,
          patientId: subject.id,
          taskId: form.task_id,
          guidelinePath: guidelineDir(form.task_id),
          mcpServers,
          hooks: sdkHooks,
          maxTurns: opts.maxTurns ?? 60,
          permissionMode: "acceptEdits",
          model: opts.model,
          provider: opts.provider,
          extraSystemPrompt: profile.buildExtraSystemPrompt(ctx),
        })) {
          // We don't process events here — agent commits via MCP, which
          // writes review_state.json under scratchRoot. We read it after.
        }
      });

      const out = await profile.readScratchOutput(ctx);
      return {
        extractor_id,
        task_id: form.task_id,
        subject_id: subject.id,
        cells: out.cells,
        ...(out.spans ? { spans: out.spans } : {}),
      };
    },
  };
}

// ── default phenotype profile ───────────────────────────────────────────

/**
 * The original phenotype-validation behavior, kept exactly as it was
 * before the profile hook landed so callers that don't pass `profile`
 * see no behavior change.
 */
export const defaultPhenotypeProfile: ExtractorProfile = {
  id: "v1-agent-phenotype",
  buildMcpServers(ctx) {
    // The chart_review_state MCP server config v1 builds. Per-run
    // reviewsRoot redirect rides on the subprocess transport (when
    // AGENT_PROVIDER=codex) via env var, and on in-process transport
    // (when AGENT_PROVIDER=claude) via withReviewsRoot.
    return buildMcpServersConfig(
      ctx.subject.id,
      ctx.task,
      ctx.sessionId,
      { onStateUpdate: () => {} },
      { reviewsRoot: ctx.scratchRoot, provider: ctx.provider },
    );
  },
  buildPrompt(ctx) {
    const { form, subject } = ctx;
    return [
      "You are running in batch mode. Activate the `chart-review` skill.",
      `If a skill named \`chart-review-${form.task_id}-phenotype\` exists, activate it as well — it provides the rubric scope.`,
      "",
      `Active subject: ${subject.type} ${subject.id}`,
      `Active guideline: ${form.task_id}`,
      `Criteria to fill: ${form.criteria.length} (${form.criteria.filter((c) => !c.derivation).length} leaf, ${form.criteria.filter((c) => c.derivation).length} derived)`,
      "",
      "Read the patient's notes (under your cwd), then commit one assessment per",
      "leaf criterion via the chart_review_state MCP tools (set_field_assessment,",
      "select_evidence). Use find_quote_offsets BEFORE citing any note quote so",
      "faithfulness validation passes. After all leaf criteria are answered,",
      "you are done — emit a brief summary line and stop.",
    ].join("\n");
  },
  buildExtraSystemPrompt() {
    return (
      "You are running unattended in batch mode (chart-review-platform-v2). " +
      "There is no human in the loop for this subject — produce your draft and stop. " +
      "Do not ask clarifying questions; pick the most defensible answer with the " +
      "evidence available."
    );
  },
  async readScratchOutput(ctx) {
    const cells = await readScratchAssessments(
      ctx.scratchRoot, ctx.subject.id, ctx.form.task_id,
    );
    return { cells };
  },
};

async function readScratchAssessments(
  scratchRoot: string,
  patientId: string,
  taskId: string,
): Promise<ExtractorOutput["cells"]> {
  const fs = await import("node:fs");
  const fp = path.join(scratchRoot, patientId, taskId, "review_state.json");
  if (!fs.existsSync(fp)) return [];
  try {
    const state = JSON.parse(await fs.promises.readFile(fp, "utf8")) as {
      field_assessments?: ExtractorOutput["cells"];
    };
    return state.field_assessments ?? [];
  } catch {
    return [];
  }
}
