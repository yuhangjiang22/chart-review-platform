// Chart-review workflow — wires the 6 modules with chart-review adapters.

import path from "node:path";
import { makeChartReviewClarify } from "../modules/1-clarify/index.js";
import { makeChartReviewFormGen } from "../modules/2-form-gen/index.js";
import { makeChartReviewDiscover } from "../modules/3-discover/index.js";
import {
  makeStubExtract, makeV1AgentExtract, verifyEvidenceFaithfulness,
  type ExtractModule,
} from "../modules/4-extract/index.js";
import { makeReconciler, makeV1Judge } from "../modules/5-validate/index.js";
import { makeCorrectLog } from "../modules/6-correct-log/index.js";
import type {
  TaskSpec, SubjectRef, FinalizedAssessment, ExtractorOutput, ProviderName,
} from "../shared/types.js";

export interface ChartReviewPipelineOpts {
  corpusRoot: string;
  reviewsRoot: string;
  /** "stub" → deterministic offline extractor (default; fast, no tokens).
   *  "v1-agent" → wraps v1's runAgent — real Claude/Codex calls. */
  extractorMode?: "stub" | "v1-agent";
  /** When extractorMode = "v1-agent": which provider to use per extractor.
   *  Defaults to [undefined, undefined] (= env-var AGENT_PROVIDER for both). */
  providers?: [ProviderName | undefined, ProviderName | undefined];
  /** Enable the LLM pre-screen on disagreed/low-confidence cells.
   *  Uses v1's chart-review-judge skill via makeV1Judge. */
  runJudge?: boolean;
}

export function makeChartReviewPipeline(opts: ChartReviewPipelineOpts) {
  const clarify = makeChartReviewClarify();
  const formGen = makeChartReviewFormGen();
  const discover = makeChartReviewDiscover({ corpusRoot: opts.corpusRoot });

  let extractDefault: ExtractModule;
  let extractSkeptical: ExtractModule;
  if (opts.extractorMode === "v1-agent") {
    // Real Claude/Codex runs via v1's runAgent. Each extractor needs a
    // cwd (the patient dir); we resolve per-call inside runOne below.
    // Two slots map onto v1's agent_default + agent_skeptical pattern.
    extractDefault = makeV1AgentExtract({ cwd: opts.corpusRoot, provider: opts.providers?.[0] });
    extractSkeptical = makeV1AgentExtract({ cwd: opts.corpusRoot, provider: opts.providers?.[1] });
  } else {
    extractDefault = makeStubExtract({ answerBias: "no", confidenceBias: "high" });
    extractSkeptical = makeStubExtract({ answerBias: "no", confidenceBias: "medium" });
  }

  const reconciler = makeReconciler();
  const correctLog = makeCorrectLog({ reviewsRoot: path.join(opts.reviewsRoot, "chart-review") });

  return {
    clarify, formGen, discover, reconciler, correctLog,
    /** End-to-end: clarify → form → discover → 2× extract → reconcile → seed.
     *  When `opts.runJudge` is true, the reconciler invokes v1's
     *  chart-review-judge skill on each needs_human cell to pre-screen
     *  it for the human reviewer. */
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

      // Optional judge: same v1 skill the chart-review platform uses.
      // Constructed per-call so the patientId is the actual subject.
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
