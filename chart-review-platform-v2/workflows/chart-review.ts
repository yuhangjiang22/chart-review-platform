// Chart-review workflow — wires the 6 modules with chart-review adapters.

import path from "node:path";
import { makeChartReviewClarify } from "../modules/1-clarify/index.js";
import { makeChartReviewFormGen } from "../modules/2-form-gen/index.js";
import { makeChartReviewDiscover } from "../modules/3-discover/index.js";
import {
  makeV1AgentExtract, verifyEvidenceFaithfulness,
} from "../modules/4-extract/index.js";
import { makeReconciler, makeV1Judge } from "../modules/5-validate/index.js";
import { makeCorrectLog } from "../modules/6-correct-log/index.js";
import type {
  TaskSpec, SubjectRef, FinalizedAssessment, ExtractorOutput, ProviderName,
} from "../shared/types.js";

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
  const extractDefault = makeV1AgentExtract({ cwd: opts.corpusRoot, provider: opts.providers?.[0] });
  const extractSkeptical = makeV1AgentExtract({ cwd: opts.corpusRoot, provider: opts.providers?.[1] });
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
