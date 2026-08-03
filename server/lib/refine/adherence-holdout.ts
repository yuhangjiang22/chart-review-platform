// refine/adherence-holdout.ts — held-out ④ for adherence question refinements.
//
// Method-constant re-answer: on held-out patients (never shown to the refiner),
// answer the question under the CURRENT retrieval_hints vs the CANDIDATE hints
// (current + proposed addition) and compare each to the reviewer's gold answer.
// The Δ isolates the hint's effect. Reuses the phenotype holdout primitives
// (buildExtractionPrompt / buildNotesBlock / answersAgree / MIN_HELDOUT /
// HoldoutResult) — only the guidance dir + the "criterion" framing differ.

import path from "node:path";
import { runAgent, type ProviderName } from "../agent-provider.js";
import { modelFor } from "@chart-review/model-config";
import { patientDir, PLATFORM_ROOT, isPhiPatient } from "@chart-review/patients";
import { guidelineDir } from "@chart-review/rubric";
import { loadCompiledTask } from "@chart-review/tasks";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import {
  buildExtractionPrompt,
  buildNotesBlock,
  answersAgree,
  MIN_HELDOUT,
  type HoldoutResult,
  type HoldoutPerPatient,
} from "./holdout.js";

function extractorModel(): string | undefined {
  return modelFor("judge") ?? modelFor("default");
}
function extractSentinel(text: string, tag: string): string | null {
  const i = text.indexOf(`<${tag}>`);
  if (i < 0) return null;
  const j = text.indexOf(`</${tag}>`, i + tag.length + 2);
  if (j < 0) return null;
  return text.slice(i + tag.length + 2, j).trim();
}

/** Compose the "criterion" text the extractor answers: the question + its
 *  retrieval guidance. The hints are the ONLY thing that varies old vs new. */
function questionCriterionText(questionText: string, hints: string): string {
  const h = hints.trim();
  return h ? `${questionText.trim()}\n\nRetrieval guidance:\n${h}` : questionText.trim();
}

async function answerOnce(args: {
  taskId: string;
  questionId: string;
  patientId: string;
  criterionText: string;
  answerEnum?: string[];
  notesBlock: string;
  mcpServers: unknown;
  provider?: ProviderName;
}): Promise<{ answer?: unknown; cost?: number; error?: string }> {
  let resultText = "";
  let cost: number | undefined;
  try {
    for await (const event of runAgent({
      prompt: buildExtractionPrompt({
        taskId: args.taskId,
        fieldId: args.questionId,
        criterionText: args.criterionText,
        answerEnum: args.answerEnum,
        notesBlock: args.notesBlock,
      }),
      cwd: patientDir(args.patientId),
      patientId: args.patientId,
      taskId: args.taskId,
      guidelinePath: guidelineDir(args.taskId),
      mcpServers: args.mcpServers as never,
      phi: isPhiPatient(args.patientId),
      maxTurns: 6,
      model: extractorModel(),
      provider: args.provider,
      extraSystemPrompt:
        "You are a single-question chart extractor. Reason only from the inline " +
        "notes + question. Emit ONE JSON record wrapped in <EXTRACT> sentinels. " +
        "Do not read files, do not commit, do not narrate.",
    })) {
      if (event.type === "result") {
        if (event.result) resultText = event.result;
        if (typeof event.cost_usd === "number") cost = event.cost_usd;
      } else if (event.type === "error") {
        throw new Error(event.error);
      }
    }
  } catch (e) {
    return { error: (e as Error).message, cost };
  }
  const wrapped = extractSentinel(resultText, "EXTRACT");
  if (!wrapped) return { error: "extractor response missing <EXTRACT> sentinel", cost };
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapped);
  } catch (e) {
    return { error: `extractor response was not valid JSON: ${(e as Error).message}`, cost };
  }
  if (!parsed || typeof parsed !== "object" || !("answer" in (parsed as object))) {
    return { error: "extractor response missing `answer` field", cost };
  }
  return { answer: (parsed as { answer: unknown }).answer, cost };
}

export interface RescoreQuestionInput {
  taskId: string;
  questionId: string;
  questionText: string;
  retrievalHintsOld: string;
  retrievalHintsNew: string;
  heldoutPatients: string[];
  gold: Record<string, unknown>;
  answerEnum?: string[];
  provider?: ProviderName;
}

/**
 * Re-answer the question on held-out patients under old vs candidate hints and
 * compute the ④ Δ. Two focused calls per patient; a patient is scored only when
 * BOTH produced a usable answer. insufficient_holdout when too few.
 */
export async function rescoreQuestionOnHeldout(input: RescoreQuestionInput): Promise<HoldoutResult> {
  const start = Date.now();
  const heldoutN = input.heldoutPatients.length;
  if (heldoutN < MIN_HELDOUT) {
    return {
      insufficient_holdout: true,
      heldout_n: heldoutN,
      reason: `only ${heldoutN} held-out patient(s); need ≥ ${MIN_HELDOUT} to measure a meaningful Δ`,
    };
  }

  const task = loadCompiledTask(input.taskId);
  const scratch = path.join(PLATFORM_ROOT, "var", "_refine_scratch", `adh-holdout-${input.taskId}-${input.questionId}`);
  const oldText = questionCriterionText(input.questionText, input.retrievalHintsOld);
  const newText = questionCriterionText(input.questionText, input.retrievalHintsNew);

  let totalCost = 0;
  let model = extractorModel() ?? "(unknown)";
  const per: HoldoutPerPatient[] = [];

  for (const pid of input.heldoutPatients) {
    const gold = input.gold[pid];
    const notesBlock = buildNotesBlock(pid);
    const mcpServers = task
      ? buildMcpServersConfig(pid, task, `adh-holdout-${input.questionId}-${pid}`, { onStateUpdate: () => {} }, { reviewsRoot: scratch, provider: input.provider })
      : undefined;
    const common = { taskId: input.taskId, questionId: input.questionId, patientId: pid, answerEnum: input.answerEnum, notesBlock, mcpServers, provider: input.provider };
    const oldR = await answerOnce({ ...common, criterionText: oldText });
    const newR = await answerOnce({ ...common, criterionText: newText });
    totalCost += (oldR.cost ?? 0) + (newR.cost ?? 0);
    per.push({
      pid,
      gold,
      ans_old: oldR.answer,
      ans_new: newR.answer,
      error: oldR.error ?? newR.error,
    });
  }

  const scored = per.filter((p) => !p.error);
  const scoredN = scored.length;
  if (scoredN < MIN_HELDOUT) {
    return {
      insufficient_holdout: true,
      heldout_n: heldoutN,
      reason: `only ${scoredN} of ${heldoutN} held-out patient(s) produced a usable answer on both calls; need ≥ ${MIN_HELDOUT}`,
    };
  }

  let okOld = 0;
  let okNew = 0;
  let nFixed = 0;
  let nRegressed = 0;
  for (const p of scored) {
    const oldOk = answersAgree(p.ans_old, p.gold);
    const newOk = answersAgree(p.ans_new, p.gold);
    if (oldOk) okOld++;
    if (newOk) okNew++;
    if (!oldOk && newOk) nFixed++;
    if (oldOk && !newOk) nRegressed++;
  }
  const agreementOld = okOld / scoredN;
  const agreementNew = okNew / scoredN;

  return {
    agreement_old: agreementOld,
    agreement_new: agreementNew,
    delta: agreementNew - agreementOld,
    n_fixed: nFixed,
    n_regressed: nRegressed,
    heldout_n: heldoutN,
    scored_n: scoredN,
    per_patient: per,
    model,
    cost_usd: totalCost,
    duration_ms: Date.now() - start,
  };
}
