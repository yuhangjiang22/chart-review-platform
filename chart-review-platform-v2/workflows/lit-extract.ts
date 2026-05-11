// Lit-extract workflow — same 6 modules, different adapters.

import path from "node:path";
import { makeLitExtractClarify } from "../modules/1-clarify/index.js";
import { makeLitExtractFormGen } from "../modules/2-form-gen/index.js";
import { makeLitExtractDiscover } from "../modules/3-discover/index.js";
import {
  makeStubExtract, makeV1AgentExtract, verifyEvidenceFaithfulness,
  type ExtractModule,
} from "../modules/4-extract/index.js";
import { makeReconciler, makeV1Judge } from "../modules/5-validate/index.js";
import { makeCorrectLog } from "../modules/6-correct-log/index.js";
import type {
  TaskSpec, SubjectRef, FinalizedAssessment, ExtractorOutput, ProviderName,
} from "../shared/types.js";

export interface LitExtractPipelineOpts {
  /** Optional offline fixtures (one .txt per subject.id). */
  fixtureRoot?: string;
  reviewsRoot: string;
  extractorMode?: "stub" | "v1-agent";
  providers?: [ProviderName | undefined, ProviderName | undefined];
  runJudge?: boolean;
}

export function makeLitExtractPipeline(opts: LitExtractPipelineOpts) {
  const clarify = makeLitExtractClarify();
  const formGen = makeLitExtractFormGen();
  const discover = makeLitExtractDiscover({ fixtureRoot: opts.fixtureRoot });

  let extractA: ExtractModule;
  let extractB: ExtractModule;
  if (opts.extractorMode === "v1-agent") {
    const cwd = opts.fixtureRoot ?? process.cwd();
    extractA = makeV1AgentExtract({ cwd, provider: opts.providers?.[0] });
    extractB = makeV1AgentExtract({ cwd, provider: opts.providers?.[1] });
  } else {
    extractA = makeStubExtract({ answerBias: "yes", confidenceBias: "high" });
    extractB = makeStubExtract({ answerBias: "yes", confidenceBias: "medium" });
  }

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
