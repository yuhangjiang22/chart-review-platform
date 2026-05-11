// Chart-review workflow — wires the 6 modules with chart-review adapters.

import path from "node:path";
import { makeChartReviewClarify } from "../modules/1-clarify/index.js";
import { makeChartReviewFormGen } from "../modules/2-form-gen/index.js";
import { makeChartReviewDiscover } from "../modules/3-discover/index.js";
import { makeStubExtract, verifyEvidenceFaithfulness } from "../modules/4-extract/index.js";
import { makeReconciler } from "../modules/5-validate/index.js";
import { makeCorrectLog } from "../modules/6-correct-log/index.js";
import type {
  TaskSpec, SubjectRef, FinalizedAssessment, ExtractorOutput,
} from "../shared/types.js";

export interface ChartReviewPipelineOpts {
  corpusRoot: string;
  reviewsRoot: string;
}

export function makeChartReviewPipeline(opts: ChartReviewPipelineOpts) {
  const clarify = makeChartReviewClarify();
  const formGen = makeChartReviewFormGen();
  const discover = makeChartReviewDiscover({ corpusRoot: opts.corpusRoot });
  // Two extractors — the default + skeptical pattern from v1.
  const extractDefault = makeStubExtract({ answerBias: "no", confidenceBias: "high" });
  const extractSkeptical = makeStubExtract({ answerBias: "no", confidenceBias: "medium" });
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

      const draft = await reconciler.reconcile(outputs);
      return correctLog.seed(draft);
    },
  };
}
