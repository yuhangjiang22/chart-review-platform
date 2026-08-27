// refine/adherence-candidates.ts — adherence port of the refinement attribution.
//
// Closest to phenotype of the three kinds: the unit is a QUESTION (question_id)
// and the answers are scalars (string | number | boolean), so a mismatch is a
// per-(patient, question) cell exactly like phenotype's field cell. The edit
// target is the question's `retrieval_hints` guidance in its tier YAML.
//
// Human gold = question_answers with source==="reviewer", restricted to
// validated_questions, on reviewer_validated patients. Agent draft =
// question_answers from the iter run's agents. Rule verdicts are deterministic
// (rule engine) and NOT refinable — they're ignored here; only questions feed
// the loop. No judge needed: attribution comes from the model-vs-human compare
// + the error-analysis pass (the judge-free design).

import fs from "node:fs";
import path from "node:path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { loadCompiledTask } from "@chart-review/tasks";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
import type { QuestionAnswer } from "@chart-review/platform-types";
import { computeTaskSha } from "@chart-review/lock";
import { guidelineDir } from "@chart-review/rubric";
import { runChainForIter } from "./candidates.js";

// ── Public shapes ────────────────────────────────────────────────────────────

export interface AdherenceRefinementExample {
  patient_id: string;
  agent_id: string;
  question_id: string;
  agent_answer: unknown;
  reviewer_answer: unknown;
  /** First reviewer-cited note + quote, if any (the ① evidence). */
  note_id: string | null;
  excerpt: string | null;
}

export interface AdherenceRefinementCluster {
  question_id: string;
  /** The question text (context for the refiner). */
  question_text: string | null;
  /** The question's retrieval_hints — the editable guidance the refiner improves.
   *  Null when the question has none yet. */
  retrieval_hints: string | null;
  tier: number | null;
  /** answer_schema.enum as strings, for the held-out extractor. Null when none. */
  answer_enum: string[] | null;
  examples: AdherenceRefinementExample[];
  n_disagreements: number;
}

export interface AdherenceRefinementCandidates {
  task_id: string;
  iter_id: string;
  session_id: string;
  n_validated_patients: number;
  clusters: AdherenceRefinementCluster[];
  /** Per-question reviewer gold across ALL validated patients (not just
   *  disagreements): question_id → { patient_id → reviewer_answer }. The
   *  held-out re-score needs gold for held-out patients. */
  gold_by_question: Record<string, Record<string, unknown>>;
  /** Set when the run this iter refines executed against a DIFFERENT rubric than
   *  the one now on disk. Both SHAs were already recorded — the run's
   *  `guideline_sha` and the rubric's current hash — and nothing compared them.
   *
   *  It matters because the loop reads TODAY's question text and YESTERDAY's
   *  answers. On a real session that produced a wrong attribution: an agent had
   *  answered `not_applicable` in July, when the enum offered it; the option was
   *  removed in August; and the error-analysis pass read the current text, saw a
   *  value it forbids, and concluded the agent "ignored the explicit
   *  instruction". The answer had been correct when given.
   *
   *  A WARNING, not a refusal. Normal use refines an iter right after running it,
   *  where the SHAs match by construction, and an operator re-examining an older
   *  iter on purpose should not be blocked — only told what they are comparing. */
  rubric_drift?: { run_sha: string; current_sha: string };
  /** question_ids present in reviewer gold but ABSENT from the current rubric —
   *  dropped from both clusters and gold, and named here so the omission is
   *  visible rather than silent. Absent when there are none. */
  retired_questions?: string[];
  unsupported?: { task_kind: string; reason: string };
}

// ── Answer compare (mirrors adherence-iaa normalization) ───────────────────────

function norm(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim().toLowerCase();
  return v;
}
export function answersEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// ── Question definitions ───────────────────────────────────────────────────────

interface QDef {
  text: string | null;
  retrieval_hints: string | null;
  tier: number | null;
  answer_enum: string[] | null;
}

/** Flatten the skill's questions_by_tier to question_id → {text, retrieval_hints, tier}. */
export function loadQuestionDefs(taskId: string): Map<string, QDef> {
  const out = new Map<string, QDef>();
  try {
    const skill = loadAdherenceSkill(taskId);
    for (const [tier, qs] of skill.questions_by_tier) {
      for (const q of qs) {
        const en = (q.answer_schema as { enum?: unknown } | undefined)?.enum;
        out.set(q.question_id, {
          text: typeof q.text === "string" ? q.text : null,
          retrieval_hints: typeof q.retrieval_hints === "string" ? q.retrieval_hints : null,
          tier: typeof tier === "number" ? tier : null,
          answer_enum: Array.isArray(en) && en.length ? en.map((v) => String(v)) : null,
        });
      }
    }
  } catch {
    /* no skill / parse failure → empty defs (clusters still form, sans guidance) */
  }
  return out;
}

// ── Pure core (unit-testable) ──────────────────────────────────────────────────

export interface AdherencePatientInput {
  patient_id: string;
  /** question_ids the reviewer validated. */
  validated_questions: string[];
  /** Reviewer (gold) answers by question_id. */
  human_answers: Record<string, unknown>;
  /** First reviewer evidence per question_id: {note_id, quote}. */
  human_evidence?: Record<string, { note_id: string | null; quote: string | null }>;
  /** Agent draft answers: agent_id → question_id → answer. */
  agent_answers_by_agent: Record<string, Record<string, unknown>>;
}

/**
 * Build per-question disagreement clusters from validated adherence patients.
 * A disagreement = an agent answer ≠ the reviewer's validated answer on a
 * validated question. Pure — no disk, no skill load (caller fills text/hints).
 *
 * `examplePatientFilter`, when set, restricts which patients' disagreements are
 * emitted as cluster EXAMPLES (the S3 refine set); gold_by_question +
 * n_validated_patients still span ALL validated patients (the held-out re-score
 * needs held-out gold). Absent = no filter.
 */
export function buildAdherenceClusters(
  patients: AdherencePatientInput[],
  examplePatientFilter?: Set<string>,
): {
  clusters: Map<string, AdherenceRefinementCluster>;
  n_validated_patients: number;
  gold_by_question: Record<string, Record<string, unknown>>;
} {
  const clusters = new Map<string, AdherenceRefinementCluster>();
  const validatedPatients = new Set<string>();
  const goldByQuestion: Record<string, Record<string, unknown>> = {};

  function cluster(qid: string): AdherenceRefinementCluster {
    let c = clusters.get(qid);
    if (!c) {
      c = { question_id: qid, question_text: null, retrieval_hints: null, tier: null, answer_enum: null, examples: [], n_disagreements: 0 };
      clusters.set(qid, c);
    }
    return c;
  }

  for (const p of patients) {
    const validated = new Set(p.validated_questions);
    if (validated.size === 0) continue;
    validatedPatients.add(p.patient_id);

    // Record gold for every validated question on this patient (spans ALL
    // validated patients — the held-out re-score needs held-out gold).
    for (const qid of validated) {
      if (!(qid in p.human_answers)) continue;
      (goldByQuestion[qid] ??= {})[p.patient_id] = p.human_answers[qid];
    }

    // Anti-leakage: emit disagreement EXAMPLES only for refine-set patients.
    if (examplePatientFilter && !examplePatientFilter.has(p.patient_id)) continue;

    for (const [agentId, answers] of Object.entries(p.agent_answers_by_agent)) {
      for (const qid of validated) {
        if (!(qid in p.human_answers)) continue; // no gold for this question
        if (!(qid in answers)) continue; // agent didn't answer it
        if (answersEqual(answers[qid], p.human_answers[qid])) continue; // agreement
        const ev = p.human_evidence?.[qid];
        const c = cluster(qid);
        c.examples.push({
          patient_id: p.patient_id,
          agent_id: agentId,
          question_id: qid,
          agent_answer: answers[qid],
          reviewer_answer: p.human_answers[qid],
          note_id: ev?.note_id ?? null,
          excerpt: ev?.quote ?? null,
        });
        c.n_disagreements++;
      }
    }
  }

  for (const c of clusters.values()) {
    c.examples.sort((a, b) => a.patient_id.localeCompare(b.patient_id) || a.agent_id.localeCompare(b.agent_id));
  }
  return { clusters, n_validated_patients: validatedPatients.size, gold_by_question: goldByQuestion };
}

// ── Disk-wired entry point ─────────────────────────────────────────────────────

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}
function runsRootDir(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(PLATFORM_ROOT, "var", "runs");
}
function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

interface AdhReviewState {
  question_answers?: QuestionAnswer[];
  validated_questions?: string[];
  review_status?: string;
}

export function collectAdherenceRefinementCandidates(opts: {
  sessionId: string;
  taskId: string;
  iterId: string;
  /** S3 refine-set filter: emit examples only for these patients (gold spans all). */
  examplePatientFilter?: Set<string>;
}): AdherenceRefinementCandidates {
  const { sessionId, taskId, iterId, examplePatientFilter } = opts;
  const base = { task_id: taskId, iter_id: iterId, session_id: sessionId };

  const task = loadCompiledTask(taskId);
  const taskKind = task?.task_kind ?? "phenotype";
  if (taskKind !== "adherence") {
    return {
      ...base,
      n_validated_patients: 0,
      clusters: [],
      gold_by_question: {},
      unsupported: {
        task_kind: taskKind,
        reason: `adherence self-refinement supports adherence tasks only; ${taskKind} uses a different path`,
      },
    };
  }

  const run = runChainForIter(taskId, sessionId, iterId)[0];
  const sessionDir = path.join(reviewsRoot(), sessionId);
  const patients: AdherencePatientInput[] = [];

  if (run && fs.existsSync(sessionDir)) {
    for (const pid of fs.readdirSync(sessionDir)) {
      if (pid.startsWith(".")) continue;
      const state = readJson<AdhReviewState>(path.join(sessionDir, pid, taskId, "review_state.json"));
      if (!state || state.review_status !== "reviewer_validated") continue;
      const validated = state.validated_questions ?? [];
      if (validated.length === 0) continue;

      const humanAnswers: Record<string, unknown> = {};
      const humanEvidence: Record<string, { note_id: string | null; quote: string | null }> = {};
      for (const qa of state.question_answers ?? []) {
        if (qa.source !== "reviewer") continue;
        humanAnswers[qa.question_id] = qa.answer;
        const ev = Array.isArray(qa.evidence) ? qa.evidence[0] : undefined;
        humanEvidence[qa.question_id] = {
          note_id: ev?.note_id ?? null,
          quote: typeof ev?.quote === "string" ? ev.quote : null,
        };
      }

      const agentsDir = path.join(runsRootDir(), run, "per_patient", pid, "agents");
      const agentAnswersByAgent: Record<string, Record<string, unknown>> = {};
      if (fs.existsSync(agentsDir)) {
        for (const f of fs.readdirSync(agentsDir)) {
          if (!f.endsWith(".json") || f.endsWith(".error.json") || f.endsWith("_transcript.jsonl")) continue;
          const draft = readJson<{ question_answers?: QuestionAnswer[] }>(path.join(agentsDir, f));
          if (!draft) continue;
          const map: Record<string, unknown> = {};
          for (const qa of draft.question_answers ?? []) map[qa.question_id] = qa.answer;
          agentAnswersByAgent[f.replace(/\.json$/, "")] = map;
        }
      }

      patients.push({
        patient_id: pid,
        validated_questions: validated,
        human_answers: humanAnswers,
        human_evidence: humanEvidence,
        agent_answers_by_agent: agentAnswersByAgent,
      });
    }
  }

  const { clusters, n_validated_patients, gold_by_question } = buildAdherenceClusters(patients, examplePatientFilter);
  const defs = loadQuestionDefs(taskId);

  // RETIRED QUESTIONS. Gold is whatever a reviewer validated, which can outlive
  // the rubric: a question deleted in a later version still sits in old
  // review_states, and this loop would carry it forward. Its cluster arrives with
  // no text, no retrieval_hints and no enum, and the proposer would be asked to
  // append guidance to a question that no longer exists — a proposal nobody can
  // apply. Measured on a real session: T1-ControllerAdherenceProxy, gone from the
  // rubric, still present in gold.
  //
  // Dropped from BOTH clusters and gold_by_question: the held-out re-score reads
  // gold, so leaving it there would score a held-out patient on a question the
  // current rubric cannot ask.
  //
  // REPORTED, not silently filtered — a question vanishing from the loop should be
  // visible, since the alternative is a reviewer wondering why their validated
  // answers stopped mattering.
  const retired = [...new Set([
    ...clusters.keys(),
    ...Object.keys(gold_by_question),
  ])].filter((qid) => !defs.has(qid)).sort();
  for (const qid of retired) {
    clusters.delete(qid);
    delete gold_by_question[qid];
  }

  const out = [...clusters.values()].sort((a, b) => a.question_id.localeCompare(b.question_id));
  for (const c of out) {
    const d = defs.get(c.question_id);
    c.question_text = d?.text ?? null;
    c.retrieval_hints = d?.retrieval_hints ?? null;
    c.tier = d?.tier ?? null;
    c.answer_enum = d?.answer_enum ?? null;
  }

  // Did the run this iter refines execute against the rubric now on disk?
  let drift: { run_sha: string; current_sha: string } | undefined;
  try {
    const manifest = readJson<{ guideline_sha?: string }>(
      path.join(runsRootDir(), run ?? "", "manifest.json"));
    const runSha = manifest?.guideline_sha;
    const currentSha = computeTaskSha(guidelineDir(taskId));
    if (runSha && currentSha && runSha !== currentSha) {
      drift = { run_sha: runSha, current_sha: currentSha };
    }
  } catch { /* best-effort — an unreadable manifest must not fail the chain */ }

  return {
    ...base, n_validated_patients, clusters: out, gold_by_question,
    ...(retired.length > 0 ? { retired_questions: retired } : {}),
    ...(drift ? { rubric_drift: drift } : {}),
  };
}
