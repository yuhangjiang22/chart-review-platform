// Lit-extract workflow — same 6 modules, different adapters.

import path from "node:path";
import { makeLitExtractClarify } from "../modules/1-clarify/index.js";
import { makeLitExtractFormGen } from "../modules/2-form-gen/index.js";
import { makeLitExtractDiscover } from "../modules/3-discover/index.js";
import { makeStubExtract, verifyEvidenceFaithfulness } from "../modules/4-extract/index.js";
import { makeReconciler } from "../modules/5-validate/index.js";
import { makeCorrectLog } from "../modules/6-correct-log/index.js";
import type {
  TaskSpec, SubjectRef, FinalizedAssessment, ExtractorOutput,
} from "../shared/types.js";

export interface LitExtractPipelineOpts {
  /** Optional offline fixtures (one .txt per subject.id). */
  fixtureRoot?: string;
  reviewsRoot: string;
}

export function makeLitExtractPipeline(opts: LitExtractPipelineOpts) {
  const clarify = makeLitExtractClarify();
  const formGen = makeLitExtractFormGen();
  const discover = makeLitExtractDiscover({ fixtureRoot: opts.fixtureRoot });
  // Dual extractors — same pattern as chart-review.
  const extractA = makeStubExtract({ answerBias: "yes", confidenceBias: "high" });
  const extractB = makeStubExtract({ answerBias: "yes", confidenceBias: "medium" });
  const reconciler = makeReconciler();
  const correctLog = makeCorrectLog({ reviewsRoot: path.join(opts.reviewsRoot, "lit-extract") });

  return {
    clarify, formGen, discover, reconciler, correctLog,
    async runOne(prompt: string, subject: SubjectRef): Promise<FinalizedAssessment> {
      const spec: TaskSpec = await clarify.clarify(prompt);
      const form = await formGen.generate(spec);
      const corpus = await discover.discover(spec, subject);

      const outputs: ExtractorOutput[] = await Promise.all([
        extractA.extract(form, subject, corpus, "extractor_a"),
        extractB.extract(form, subject, corpus, "extractor_b"),
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
