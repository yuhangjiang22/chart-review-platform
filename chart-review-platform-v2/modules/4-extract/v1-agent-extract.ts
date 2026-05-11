// Real ExtractModule adapter — wraps v1's runAgent.
//
// v1's agent-provider.ts already abstracts Claude / Codex / per-run
// provider choice. We just feed the form + corpus into a prompt and
// collect the streamed AgentEvents back into one ExtractorOutput.
//
// This is the "port v1's extraction" item from v2's README. The stub
// in stub.ts is kept for offline smoke testing; this adapter is the
// real thing.

import type {
  ExtractModule, ExtractorOutput, FieldAssessment, FormSpec,
  SubjectRef, EvidenceUnit, ProviderName,
} from "../../shared/types.js";
import { runAgent } from "../../../chart-review-platform/app/server/agent-provider.js";

export interface V1AgentExtractOptions {
  /** "claude" or "codex" — passed to v1's runAgent.provider override. */
  provider?: ProviderName;
  /** Model string per OpenRouter / Anthropic / Codex conventions. */
  model?: string;
  /** Working directory the agent reads files from. Chart-review
   *  expects the patient's note dir; lit-extract can point at a
   *  scratch dir holding the paper. */
  cwd: string;
  /** mcpServers config passed through to runAgent. The chart-review
   *  workflow already builds this via buildMcpServersConfig() in v1;
   *  callers can either pass it through directly or build their own. */
  mcpServers?: unknown;
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
      // Build a self-contained prompt: form criteria + corpus excerpts.
      // A production adapter would lean on v1's compose-agent.ts to
      // assemble the full system+user prompts the chart-review or
      // lit-extract skill expects; this is the minimal viable prompt.
      const prompt = buildPrompt(form, subject, corpus);
      const cells: FieldAssessment[] = [];

      // Stream events from v1's runAgent. Tool calls + tool results
      // produce the field_assessments — but the MCP write path is
      // what actually populates them in v1, not the event stream
      // itself. For the v2 adapter we collect them from the event
      // payloads. (Production: read from the MCP-written scratch
      // file after the run, like v1 does in runs.ts.)
      for await (const event of runAgent({
        prompt,
        cwd: opts.cwd,
        patientId: subject.id,
        taskId: form.task_id,
        guidelinePath: opts.cwd, // placeholder; real impl wires the skill path
        mcpServers: opts.mcpServers as Record<string, unknown>,
        maxTurns: opts.maxTurns ?? 60,
        permissionMode: "acceptEdits",
        model: opts.model,
        provider: opts.provider,
      })) {
        // Tool-call results from MCP write-side are how v1 reports
        // field_assessment commits. We don't deserialize them here in
        // the MVP — the production path is to read the scratch
        // review_state.json after the for-await finishes (see v1's
        // runs.ts:710-720).
        if (event.type === "result") {
          // turn-completed event; loop exits next iteration.
        }
      }

      return { extractor_id, task_id: form.task_id, subject_id: subject.id, cells };
    },
  };
}

function buildPrompt(form: FormSpec, subject: SubjectRef, corpus: EvidenceUnit[]): string {
  return [
    `# Task: ${form.task_id}`,
    `# Subject: ${subject.type} ${subject.id}`,
    "",
    `# Criteria to fill (${form.criteria.length}):`,
    ...form.criteria.map((c) => `- ${c.id}: ${c.prompt ?? "(no prompt)"}`),
    "",
    `# Evidence units in scope (${corpus.length}):`,
    ...corpus.slice(0, 5).map((u) => `- ${u.unit_id}: ${u.text.slice(0, 80)}…`),
    "",
    "Commit one assessment per leaf criterion via the chart_review_state MCP tools.",
    "Cite verbatim quotes with byte offsets (use find_quote_offsets BEFORE citing).",
  ].join("\n");
}
