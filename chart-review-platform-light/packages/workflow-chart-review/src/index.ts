// Chart-review workflow — wires the 6 modules with chart-review adapters.

import path from "node:path";
import { makeChartReviewClarify } from "@chart-review/pipeline-clarify";
import { makeChartReviewFormGen } from "@chart-review/pipeline-form-gen";
import { makeChartReviewDiscover } from "@chart-review/pipeline-discover";
import {
  makeV1AgentExtract, verifyEvidenceFaithfulness,
} from "@chart-review/pipeline-extract";
import { makeReconciler, makeV1Judge } from "@chart-review/pipeline-validate";
import { makeCorrectLog } from "@chart-review/pipeline-correct-log";
import type {
  TaskSpec, SubjectRef, FinalizedAssessment, ExtractorOutput, ProviderName,
} from "@chart-review/v2-shared";

export interface ChartReviewPipelineOpts {
  corpusRoot: string;
  reviewsRoot: string;
  /** Which provider each of the N=2 extractors uses. Default = both
   *  inherit the AGENT_PROVIDER env var. To A/B Claude vs Codex on the
   *  same patient, pass `["claude", "codex"]`. */
  providers?: [ProviderName | undefined, ProviderName | undefined];
  /** Enable v1's chart-review-judge LLM pre-screen on cells flagged
   *  needs_human by the reconciler. */
  runJudge?: boolean;
}

export function makeChartReviewPipeline(opts: ChartReviewPipelineOpts) {
  const clarify = makeChartReviewClarify();
  const formGen = makeChartReviewFormGen();
  const discover = makeChartReviewDiscover({ corpusRoot: opts.corpusRoot });
  // Two extractors — v1's default + skeptical pattern, real LLM runs.
  // makeV1AgentExtract composes the full v1 agent context (skills,
  // MCP, audit hooks, withReviewsRoot wrap) — see its docstring.
  const extractDefault = makeV1AgentExtract({ reviewsRoot: opts.reviewsRoot, provider: opts.providers?.[0] });
  const extractSkeptical = makeV1AgentExtract({ reviewsRoot: opts.reviewsRoot, provider: opts.providers?.[1] });
  const reconciler = makeReconciler();
  const correctLog = makeCorrectLog({ reviewsRoot: path.join(opts.reviewsRoot, "chart-review") });

  return {
    clarify, formGen, discover, reconciler, correctLog,
    /** End-to-end: clarify → form → discover → 2× extract → reconcile → seed. */
    async runOne(prompt: string, subject: SubjectRef): Promise<FinalizedAssessment> {
      const spec: TaskSpec = await clarify.clarify(prompt);
      const form = await formGen.generate(spec);
      const corpus = await discover.discover(spec, subject);

      const outputs: ExtractorOutput[] = await Promise.all([
        extractDefault.extract(form, subject, corpus, "agent_default"),
        extractSkeptical.extract(form, subject, corpus, "agent_skeptical"),
      ]);
      for (const o of outputs) {
        const f = verifyEvidenceFaithfulness(o, corpus);
        if (!f.ok) throw new Error(`faithfulness violation in ${o.extractor_id}: ${JSON.stringify(f.violations)}`);
      }

      // Constructed per-call so judge knows which subject + provider.
      const judge = opts.runJudge
        ? makeV1Judge({ taskId: spec.task_id, patientId: subject.id })
        : undefined;
      const draft = await (judge
        ? makeReconciler(judge).reconcile(outputs, { runJudge: true })
        : reconciler.reconcile(outputs));

      return correctLog.seed(draft);
    },
  };
}
