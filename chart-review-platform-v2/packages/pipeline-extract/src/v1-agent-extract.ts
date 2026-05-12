// Real ExtractModule — wraps v1's runAgent and builds the same agent
// context v1's batch-run driver builds before each call.
//
// What "the same context" means concretely:
//   - cwd = patientDir(subject.id)       — agent's working dir is the patient's note dir
//   - guidelinePath = guidelineDir(taskId) — points at the active skill bundle so
//                                             chart-review + chart-review-<task>-phenotype
//                                             skills activate via Claude SDK's walk-up
//   - mcpServers = buildMcpServersConfig(...) — the 7 chart_review_state MCP tools
//                                                (set_field_assessment, find_quote_offsets, …)
//   - hooks = buildAuditHooks(...)        — every tool call captured to v1's audit-trail
//   - extraSystemPrompt                   — batch-mode framing ("you are running unattended")
//   - withReviewsRoot wrap                — redirects MCP writes into v2's reviewsRoot
//
// In short: v2's extraction looks bit-identical to v1's batch-run from
// the agent's perspective. The same skills load, the same MCP tools
// are available, the same audit log gets written, faithfulness
// gating happens at the MCP boundary (v1's mcp-handlers.ts).

import path from "node:path";
import type {
  ExtractModule, ExtractorOutput, FormSpec,
  SubjectRef, EvidenceUnit, ProviderName,
} from "@chart-review/v2-shared";
import { runAgent } from "@chart-review/agent-provider";
import { patientDir } from "@chart-review/patients";
import { guidelineDir } from "@chart-review/rubric";
import { loadCompiledTask } from "@chart-review/tasks";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import { buildAuditHooks } from "@chart-review/audit-trail";
import { withReviewsRoot } from "@chart-review/domain-review";

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
}

export function makeV1AgentExtract(opts: V1AgentExtractOptions): ExtractModule {
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

      // The chart_review_state MCP server config v1 builds. Per-run
      // reviewsRoot redirect rides on the subprocess transport (when
      // AGENT_PROVIDER=codex) via env var, and on in-process transport
      // (when AGENT_PROVIDER=claude) via withReviewsRoot below.
      const mcpServers = buildMcpServersConfig(
        subject.id,
        task,
        sessionId,
        { onStateUpdate: () => {} },
        { reviewsRoot: scratchRoot, provider: opts.provider },
      );

      const cwd = patientDir(subject.id);
      const userPrompt = buildPrompt(form, subject, corpus);

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
          extraSystemPrompt:
            "You are running unattended in batch mode (chart-review-platform-v2). " +
            "There is no human in the loop for this subject — produce your draft and stop. " +
            "Do not ask clarifying questions; pick the most defensible answer with the " +
            "evidence available.",
        })) {
          // We don't process events here — agent commits via MCP, which
          // writes review_state.json under scratchRoot. We read it after.
        }
      });

      // MCP server has written field_assessments to scratchRoot. Read
      // them back as the ExtractorOutput.cells.
      const cells = await readScratchAssessments(scratchRoot, subject.id, form.task_id);
      return { extractor_id, task_id: form.task_id, subject_id: subject.id, cells };
    },
  };
}

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

function buildPrompt(form: FormSpec, subject: SubjectRef, corpus: EvidenceUnit[]): string {
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
}
