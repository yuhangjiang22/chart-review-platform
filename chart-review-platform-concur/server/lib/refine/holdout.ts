// refine/holdout.ts — Task S3 of the self-refinement increment.
//
// The ④ "does it help" proof: measure whether appending the refiner's
// proposed_rule_text to a criterion improves agent-vs-human agreement on
// patients the refiner DIDN'T see — cheaply, via a FOCUSED, METHOD-CONSTANT
// re-score (NOT a full agentic re-run, NOT skill-file swapping).
//
// The careful design:
//
//   SPLIT  — partition the field's validated patients deterministically (by
//            patient_id hash) into a refine set (the refiner's examples are
//            drawn ONLY from here) and a held-out set (never shown to the
//            refiner). Default ~40% held-out. If held-out is too small for a
//            meaningful number we DON'T claim one — we return insufficient_holdout.
//
//   RE-SCORE — for each held-out patient, run a single-criterion DIRECT
//            extraction (one-shot LLM call: inline the criterion text + the
//            patient's notes + the answer enum, ask for just that one
//            criterion's answer). Do it TWICE: once with the CURRENT criterion
//            text, once with the CANDIDATE text (current + appended rule).
//            Compare each answer to the held-out GOLD (the reviewer's validated
//            answer for the criterion).
//
//   Δ      = agreement_new − agreement_old over held-out. Because the METHOD is
//            held constant (same one-shot extractor, same notes, same model),
//            Δ isolates the rule's effect. The ABSOLUTE agreement is a proxy
//            for the full dual-agent pipeline, not the pipeline itself — see
//            the caveat in the report. We also report n_fixed (old wrong → new
//            right) and n_regressed (old right → new wrong).
//
// This module owns the split + the re-score harness. The propose route (S2)
// wires it in: split → build refiner examples from the refine set only →
// generate the rule (S2) → rescoreCriterionOnHeldout(old vs candidate) → attach
// ④ to the card.

import path from "node:path";
import { runAgent, type ProviderName } from "../agent-provider.js";
import { modelFor } from "@chart-review/model-config";
import {
  patientDir,
  PLATFORM_ROOT,
  isPhiPatient,
  listNotes,
  readNote,
} from "@chart-review/patients";
import { phenotypeSkillDir } from "@chart-review/rubric";
import { loadCompiledTask } from "@chart-review/tasks";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";

// ── Split ──────────────────────────────────────────────────────────────────

/** Default fraction of validated patients reserved as held-out. ~40% keeps a
 *  refine set big enough to learn from while leaving a meaningful held-out. */
export const DEFAULT_HELDOUT_FRACTION = 0.4;

/** Minimum held-out patients below which we refuse to claim a Δ. With fewer
 *  than this a single patient swings agreement by a huge fraction and the
 *  number is noise, not evidence. */
export const MIN_HELDOUT = 3;

/** Deterministic, well-distributed 32-bit hash (FNV-1a) of a patient id. No
 *  Date, no Math.random — the same cohort always splits the same way, so a
 *  re-run of the proposal flow reproduces the exact held-out set. */
function hashPatientId(pid: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < pid.length; i++) {
    h ^= pid.charCodeAt(i);
    // FNV prime 16777619, kept in 32-bit via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // unsigned
}

export interface SplitResult {
  /** Patients the refiner is allowed to see disagreements from. */
  refine: string[];
  /** Patients held out from the refiner; the Δ is measured on these. */
  heldout: string[];
}

/**
 * Deterministically partition validated patients into refine + held-out.
 * A patient lands in held-out when `hash(pid) mod 1000 < fraction*1000`. The
 * threshold form (rather than sorting + slicing) keeps a patient's bucket
 * stable as the cohort grows: adding new validated patients never reshuffles
 * which side an existing patient is on. Both lists come back sorted for stable
 * downstream ordering.
 */
export function splitValidatedPatients(
  pids: string[],
  heldoutFraction: number = DEFAULT_HELDOUT_FRACTION,
): SplitResult {
  const frac = Math.min(Math.max(heldoutFraction, 0), 1);
  const threshold = Math.round(frac * 1000);
  const refine: string[] = [];
  const heldout: string[] = [];
  for (const pid of [...new Set(pids)]) {
    if (hashPatientId(pid) % 1000 < threshold) heldout.push(pid);
    else refine.push(pid);
  }
  refine.sort();
  heldout.sort();
  return { refine, heldout };
}

// ── Re-score ─────────────────────────────────────────────────────────────────

/** Per-held-out-patient result of the old-vs-new comparison. */
export interface HoldoutPerPatient {
  pid: string;
  gold: unknown;
  ans_old: unknown;
  ans_new: unknown;
  /** Set when an extraction call failed / returned no parseable answer — that
   *  patient is excluded from the agreement denominators (loud, not silent). */
  error?: string;
}

/** The ④ measurement. Either a numeric Δ result, OR the
 *  insufficient_holdout guard when the held-out set is too small. */
export type HoldoutResult =
  | {
      insufficient_holdout?: false;
      agreement_old: number;
      agreement_new: number;
      delta: number;
      n_fixed: number;
      n_regressed: number;
      heldout_n: number;
      /** Patients with a usable answer on BOTH calls — the denominator. */
      scored_n: number;
      per_patient: HoldoutPerPatient[];
      model?: string;
      cost_usd?: number;
      duration_ms: number;
    }
  | {
      insufficient_holdout: true;
      heldout_n: number;
      reason: string;
    };

export interface RescoreInput {
  taskId: string;
  fieldId: string;
  /** Prompt + definition + extraction guidance as the criterion stands now. */
  criterionTextOld: string;
  /** criterionTextOld with the proposed rule appended (the candidate rubric). */
  criterionTextNew: string;
  /** The held-out patient ids (from splitValidatedPatients().heldout). */
  heldoutPatients: string[];
  /** Reviewer's validated answer for this field, per held-out patient. */
  gold: Record<string, unknown>;
  /** Enum / allowed answers for the field, inlined into the extraction prompt
   *  so the one-shot extractor returns a comparable value. */
  answerEnum?: string[];
  /** Provider the cluster's run used; inherited so the re-score matches the
   *  pipeline's backend. */
  provider?: ProviderName;
}

/** Resolve the extractor model. Reuses the judge slot — same plumbing as the
 *  refiner; resolved at CALL time (dotenv loads after import). */
function extractorModel(): string | undefined {
  return modelFor("judge") ?? modelFor("default");
}

function extractSentinel(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = text.indexOf(open);
  if (i < 0) return null;
  const j = text.indexOf(close, i + open.length);
  if (j < 0) return null;
  return text.slice(i + open.length, j).trim();
}

/** Normalize two answers for agreement comparison. Mirrors the
 *  performance/candidates answersEqual (JSON-deep), but additionally trims +
 *  lowercases scalar strings so the extractor's "Yes" matches gold "yes". */
export function answersAgree(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    typeof v === "string" ? v.trim().toLowerCase() : v;
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  try {
    return JSON.stringify(na) === JSON.stringify(nb);
  } catch {
    return false;
  }
}

/** Cap on total note bytes inlined per extraction. The one-shot extractor only
 *  needs the chart text; we bound it so a patient with many long notes doesn't
 *  blow up the prompt (and cost). 24 KB ≈ the relevant-note budget for a single
 *  criterion. */
const NOTES_BUDGET_BYTES = 24_000;

/** Inline a patient's notes, newest-first, up to the byte budget. Each note is
 *  fenced with its filename so the extractor can cite. */
export function buildNotesBlock(patientId: string): string {
  const notes = listNotes(patientId);
  const blocks: string[] = [];
  let used = 0;
  // listNotes returns ascending by filename (date-prefixed); reverse for
  // newest-first so the budget keeps the most-recent notes when truncating.
  for (const n of [...notes].reverse()) {
    let body: string;
    try {
      body = readNote(patientId, n.filename);
    } catch {
      continue;
    }
    if (used + body.length > NOTES_BUDGET_BYTES && blocks.length > 0) break;
    blocks.push(`### ${n.filename}\n${body}`);
    used += body.length;
  }
  return blocks.join("\n\n") || "(no notes found)";
}

/** Build the focused single-criterion extraction prompt. Method-constant: the
 *  ONLY thing that varies between the old and new calls is `criterionText`. */
export function buildExtractionPrompt(args: {
  taskId: string;
  fieldId: string;
  criterionText: string;
  answerEnum?: string[];
  notesBlock: string;
}): string {
  const enumLine =
    args.answerEnum && args.answerEnum.length
      ? `The answer MUST be exactly one of: ${args.answerEnum
          .map((e) => JSON.stringify(e))
          .join(", ")}.`
      : "Answer with the single value the criterion calls for.";
  return [
    "You are a clinical chart-review extractor. Read the patient's notes below",
    "and answer ONE criterion. Reason ONLY from the inline notes + criterion;",
    "do not read files, do not use tools, do not commit anything.",
    "",
    `## Criterion (${args.taskId} / ${args.fieldId})`,
    args.criterionText.trim() || "(empty)",
    "",
    "## Answer format",
    enumLine,
    "Emit ONE JSON record wrapped in <EXTRACT>...</EXTRACT> sentinels, no other",
    "commentary:",
    "<EXTRACT>",
    '{ "answer": <the criterion answer> }',
    "</EXTRACT>",
    "",
    "## Patient notes",
    args.notesBlock,
  ].join("\n");
}

/** Run ONE focused extraction call for a patient under a given criterion text.
 *  Returns the parsed answer, or null on failure (sentinel/JSON/agent error). */
async function extractOnce(args: {
  taskId: string;
  fieldId: string;
  patientId: string;
  criterionText: string;
  answerEnum?: string[];
  notesBlock: string;
  mcpServers: unknown;
  provider?: ProviderName;
}): Promise<{ answer?: unknown; cost?: number; error?: string }> {
  const cwd = patientDir(args.patientId);
  const guidelinePath = phenotypeSkillDir(args.taskId);
  let resultText = "";
  let cost: number | undefined;
  try {
    for await (const event of runAgent({
      prompt: buildExtractionPrompt({
        taskId: args.taskId,
        fieldId: args.fieldId,
        criterionText: args.criterionText,
        answerEnum: args.answerEnum,
        notesBlock: args.notesBlock,
      }),
      cwd,
      patientId: args.patientId,
      taskId: args.taskId,
      guidelinePath,
      mcpServers: args.mcpServers as never,
      phi: isPhiPatient(args.patientId),
      // One focused turn — read inline, answer. Small budget keeps cost bounded.
      maxTurns: 6,
      model: extractorModel(),
      provider: args.provider,
      extraSystemPrompt:
        "You are a single-criterion chart extractor. Reason only from the " +
        "inline notes + criterion. Emit ONE JSON record wrapped in <EXTRACT> " +
        "sentinels. Do not read files, do not commit, do not narrate.",
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

/**
 * Re-score the held-out set under the old vs candidate criterion text and
 * compute the ④ Δ. For each held-out patient we run TWO focused extraction
 * calls (old, new) and compare each to the patient's gold. A patient is scored
 * only when BOTH calls produced a usable answer; failures are surfaced
 * per-patient and excluded from the denominators (loud, not silent).
 *
 * Returns insufficient_holdout (no Δ claimed) when the held-out set is below
 * MIN_HELDOUT.
 */
export async function rescoreCriterionOnHeldout(
  input: RescoreInput,
): Promise<HoldoutResult> {
  const start = Date.now();
  const heldoutN = input.heldoutPatients.length;

  if (heldoutN < MIN_HELDOUT) {
    return {
      insufficient_holdout: true,
      heldout_n: heldoutN,
      reason: `only ${heldoutN} held-out patient(s); need ≥ ${MIN_HELDOUT} to measure a meaningful Δ`,
    };
  }

  // One scratch MCP config reused across all calls — the extractor is a pure
  // reasoning call (reads inline, never commits), so it points at a throwaway
  // reviewsRoot exactly like the judge/refiner. A representative patient gives
  // the provider the cwd/patient context it requires.
  const representativePid = input.heldoutPatients[0];
  const task = loadCompiledTask(input.taskId);
  const scratch = path.join(
    PLATFORM_ROOT,
    "var",
    "_refine_scratch",
    `holdout-${input.taskId}-${input.fieldId}`,
  );
  const mcpServers = task
    ? buildMcpServersConfig(
        representativePid,
        task,
        `refine-holdout-${input.taskId}-${input.fieldId}`,
        { onStateUpdate: () => {} },
        { reviewsRoot: scratch, provider: input.provider },
      )
    : undefined;

  let totalCost = 0;
  let sawCost = false;
  const perPatient: HoldoutPerPatient[] = [];

  for (const pid of input.heldoutPatients) {
    const gold = input.gold[pid];
    const notesBlock = buildNotesBlock(pid);
    const common = {
      taskId: input.taskId,
      fieldId: input.fieldId,
      patientId: pid,
      answerEnum: input.answerEnum,
      notesBlock,
      mcpServers,
      provider: input.provider,
    };
    // Two focused calls per patient — old criterion, then candidate criterion.
    const oldRes = await extractOnce({ ...common, criterionText: input.criterionTextOld });
    const newRes = await extractOnce({ ...common, criterionText: input.criterionTextNew });
    if (typeof oldRes.cost === "number") { totalCost += oldRes.cost; sawCost = true; }
    if (typeof newRes.cost === "number") { totalCost += newRes.cost; sawCost = true; }

    const errorParts: string[] = [];
    if (oldRes.error) errorParts.push(`old: ${oldRes.error}`);
    if (newRes.error) errorParts.push(`new: ${newRes.error}`);
    perPatient.push({
      pid,
      gold,
      ans_old: oldRes.answer,
      ans_new: newRes.answer,
      ...(errorParts.length ? { error: errorParts.join("; ") } : {}),
    });
  }

  // Score only patients with a usable answer on BOTH calls.
  const scored = perPatient.filter((p) => !p.error);
  const scoredN = scored.length;
  let nOldRight = 0;
  let nNewRight = 0;
  let nFixed = 0;
  let nRegressed = 0;
  for (const p of scored) {
    const oldOk = answersAgree(p.ans_old, p.gold);
    const newOk = answersAgree(p.ans_new, p.gold);
    if (oldOk) nOldRight += 1;
    if (newOk) nNewRight += 1;
    if (!oldOk && newOk) nFixed += 1;
    if (oldOk && !newOk) nRegressed += 1;
  }
  const agreementOld = scoredN === 0 ? 0 : nOldRight / scoredN;
  const agreementNew = scoredN === 0 ? 0 : nNewRight / scoredN;

  // If too few patients yielded a usable answer on both calls, the Δ is noise —
  // disclaim it the same way as a too-small held-out set.
  if (scoredN < MIN_HELDOUT) {
    return {
      insufficient_holdout: true,
      heldout_n: heldoutN,
      reason: `only ${scoredN} of ${heldoutN} held-out patient(s) produced a usable answer on both extraction calls; need ≥ ${MIN_HELDOUT}`,
    };
  }

  return {
    agreement_old: agreementOld,
    agreement_new: agreementNew,
    delta: agreementNew - agreementOld,
    n_fixed: nFixed,
    n_regressed: nRegressed,
    heldout_n: heldoutN,
    scored_n: scoredN,
    per_patient: perPatient,
    model: extractorModel(),
    cost_usd: sawCost ? totalCost : undefined,
    duration_ms: Date.now() - start,
  };
}
