// Lit-extract workflow — same 6 modules, different adapters.

import path from "node:path";
import { makeLitExtractClarify } from "@chart-review/pipeline-clarify";
import { makeLitExtractFormGen } from "@chart-review/pipeline-form-gen";
import { makeLitExtractDiscover } from "@chart-review/pipeline-discover";
import {
  makeV1AgentExtract, verifyEvidenceFaithfulness,
} from "@chart-review/pipeline-extract";
import { makeReconciler, makeV1Judge } from "@chart-review/pipeline-validate";
import { makeCorrectLog } from "@chart-review/pipeline-correct-log";
import type {
  TaskSpec, SubjectRef, FinalizedAssessment, ExtractorOutput, ProviderName,
} from "@chart-review/v2-shared";

export interface LitExtractPipelineOpts {
  /** Optional offline fixtures (one .txt per subject.id). */
  fixtureRoot?: string;
  reviewsRoot: string;
  providers?: [ProviderName | undefined, ProviderName | undefined];
  runJudge?: boolean;
}

export function makeLitExtractPipeline(opts: LitExtractPipelineOpts) {
  const clarify = makeLitExtractClarify();
  const formGen = makeLitExtractFormGen();
  const discover = makeLitExtractDiscover({ fixtureRoot: opts.fixtureRoot });
  const extractA = makeV1AgentExtract({ reviewsRoot: opts.reviewsRoot, provider: opts.providers?.[0] });
  const extractB = makeV1AgentExtract({ reviewsRoot: opts.reviewsRoot, provider: opts.providers?.[1] });
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
