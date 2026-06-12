// Per-agent IAA for adherence tasks — agent leaderboard for DECIDE.
//
// GET /api/pilots/:taskId/:iterId/adherence-iaa
//   → {
//       n_patients,
//       per_agent: [
//         {
//           agent_id, role_preset,
//           question_score: { correct, total, match_rate, kappa? },
//           rule_score:     { concordant, total, match_rate, kappa? },
//           question_disagreements: [{ question_id, patient_id, agent_answer,
//                                      reviewer_answer, confidence }, …],
//           rule_disagreements:     [{ rule_id, patient_id, agent_verdict,
//                                      reviewer_verdict }, …],
//         }, …
//       ],
//       inter_agent: {  // A1 vs A2 (only when ≥ 2 agents in the iter)
//         question_kappa_macro, rule_kappa_macro,
//         question_agreement_rate, rule_agreement_rate,
//       },
//     }
//
// What's compared:
//   - Per-agent score: agent's draft answers/verdicts vs the reviewer's
//     persisted answers in review_state (source=reviewer). Empty when the
//     reviewer hasn't validated anything yet — we still return zeros so
//     the UI can render "n/a, validate at least one question to score."
//   - Inter-agent: A1 vs A2 across the validated cohort. No reviewer
//     needed; available immediately after TRY.
//
// Patient set comes from the iter's run status. Agents come from the run
// manifest's agent_specs.

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { pathFor } from "@chart-review/storage";
import { getPilotManifest } from "./lib/domain/iter/index.js";
import {
  getRunManifest, getRunStatus, agentDraftPath,
} from "./lib/infra/batch-run/index.js";
import {
  computePerQuestionMetrics, computePerRuleMetrics, cohensKappa,
} from "@chart-review/eval-adherence-iaa";
import type {
  QuestionAnswer, RuleVerdict,
} from "@chart-review/platform-types";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

interface DraftFile {
  question_answers?: QuestionAnswer[];
  rule_verdicts?: RuleVerdict[];
}

function readDraft(fp: string): DraftFile | null {
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, "utf8")) as DraftFile; }
  catch { return null; }
}

interface ReviewerView {
  question_answers: QuestionAnswer[];
  rule_verdicts:    RuleVerdict[];
  validated_questions: Set<string>;
  validated_rules:     Set<string>;
}

function readReviewer(sessionId: string, pid: string, taskId: string): ReviewerView {
  const fp = pathFor.reviewState(sessionId, pid, taskId);
  if (!fs.existsSync(fp)) {
    return {
      question_answers: [], rule_verdicts: [],
      validated_questions: new Set(), validated_rules: new Set(),
    };
  }
  try {
    const d = JSON.parse(fs.readFileSync(fp, "utf8")) as {
      question_answers?: QuestionAnswer[];
      rule_verdicts?: RuleVerdict[];
      validated_questions?: string[];
      validated_rules?: string[];
    };
    return {
      question_answers: (d.question_answers ?? [])
        .filter((q) => q.source === "reviewer"),
      rule_verdicts: (d.rule_verdicts ?? [])
        .filter((r) => r.source === "reviewer"),
      validated_questions: new Set(d.validated_questions ?? []),
      validated_rules:     new Set(d.validated_rules ?? []),
    };
  } catch {
    return {
      question_answers: [], rule_verdicts: [],
      validated_questions: new Set(), validated_rules: new Set(),
    };
  }
}

interface AgentScoreRow {
  agent_id: string;
  role_preset?: string;
  question_score: {
    correct: number; total: number; match_rate: number; kappa: number | null;
  };
  rule_score: {
    concordant: number; total: number; match_rate: number; kappa: number | null;
  };
  question_disagreements: Array<{
    patient_id: string; question_id: string;
    agent_answer: unknown; reviewer_answer: unknown;
    confidence?: number;
  }>;
  rule_disagreements: Array<{
    patient_id: string; rule_id: string;
    agent_verdict: string; reviewer_verdict: string;
  }>;
}

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  return v;
}

export const adherenceIaaRoutes: RouteEntry[] = [
  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId/adherence-iaa",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      if (task.task_kind !== "adherence") {
        throw httpErr(
          400,
          `task ${p.taskId} is not an adherence task (task_kind=${task.task_kind ?? "phenotype"})`,
        );
      }
      const pilot = getPilotManifest(p.taskId, p.iterId);
      if (!pilot) throw httpErr(404, `pilot ${p.iterId} not found`);
      const run = getRunManifest(pilot.run_id);
      if (!run) throw httpErr(404, `run ${pilot.run_id} not found`);
      // The iteration pins exactly one session. A legacy iter with no
      // session_id reads NOTHING — empty patient list, zeroed leaderboard —
      // rather than falling back to the flat review_state path.
      const sessionId = pilot.session_id;
      const status = getRunStatus(pilot.run_id);
      const patientIds = sessionId && status?.per_patient
        ? Object.keys(status.per_patient)
        : [];

      const agentSpecs = run.agent_specs ?? [{ id: "agent_1", role_preset: "default", role_version: "v1" as const }];

      // Pre-load reviewer view per patient (the gold standard, same
      // across all agents).
      const reviewerByPid = new Map<string, ReviewerView>();
      for (const pid of patientIds) reviewerByPid.set(pid, readReviewer(sessionId!, pid, p.taskId));

      // Per-agent leaderboard.
      const perAgent: AgentScoreRow[] = [];
      for (const spec of agentSpecs) {
        let qCorrect = 0, qTotal = 0;
        let rOk = 0, rTotal = 0;
        const qDis: AgentScoreRow["question_disagreements"] = [];
        const rDis: AgentScoreRow["rule_disagreements"] = [];

        // For κ across agent answers (one cell per question_id × patient).
        const qCells: Array<{ rater_a: string; rater_b: string }> = [];
        const rCells: Array<{ rater_a: string; rater_b: string }> = [];

        for (const pid of patientIds) {
          const dpath = agentDraftPath(pilot.run_id, pid, spec.id);
          const draft = readDraft(dpath);
          if (!draft) continue;
          const rev = reviewerByPid.get(pid)!;
          const revQByQid = new Map(rev.question_answers.map((q) => [q.question_id, q]));
          const revVByRid = new Map(rev.rule_verdicts.map((v) => [v.rule_id, v]));

          for (const aq of draft.question_answers ?? []) {
            const rq = revQByQid.get(aq.question_id);
            if (!rq) continue; // reviewer hasn't validated this question
            qTotal++;
            const same = JSON.stringify(normalize(aq.answer)) === JSON.stringify(normalize(rq.answer));
            if (same) qCorrect++;
            else qDis.push({
              patient_id: pid,
              question_id: aq.question_id,
              agent_answer: aq.answer ?? null,
              reviewer_answer: rq.answer ?? null,
              confidence: aq.confidence,
            });
            qCells.push({
              rater_a: JSON.stringify(normalize(aq.answer)),
              rater_b: JSON.stringify(normalize(rq.answer)),
            });
          }
          for (const av of draft.rule_verdicts ?? []) {
            const rv = revVByRid.get(av.rule_id);
            if (!rv) continue;
            rTotal++;
            const same = av.verdict === rv.verdict;
            if (same) rOk++;
            else rDis.push({
              patient_id: pid,
              rule_id: av.rule_id,
              agent_verdict: av.verdict,
              reviewer_verdict: rv.verdict,
            });
            rCells.push({ rater_a: av.verdict, rater_b: rv.verdict });
          }
        }

        const qKappa = qCells.length >= 2 ? cohensKappa(qCells) : null;
        const rKappa = rCells.length >= 2 ? cohensKappa(rCells) : null;
        perAgent.push({
          agent_id: spec.id,
          role_preset: spec.role_preset,
          question_score: {
            correct: qCorrect, total: qTotal,
            match_rate: qTotal > 0 ? qCorrect / qTotal : 0,
            kappa: (qKappa !== null && Number.isFinite(qKappa)) ? qKappa : null,
          },
          rule_score: {
            concordant: rOk, total: rTotal,
            match_rate: rTotal > 0 ? rOk / rTotal : 0,
            kappa: (rKappa !== null && Number.isFinite(rKappa)) ? rKappa : null,
          },
          question_disagreements: qDis,
          rule_disagreements: rDis,
        });
      }

      // Inter-agent (A1 vs A2) — only when ≥ 2 agents.
      let interAgent: {
        agent_a: string; agent_b: string;
        question_agreement_rate: number; rule_agreement_rate: number;
        question_kappa: number | null; rule_kappa: number | null;
      } | null = null;
      if (agentSpecs.length >= 2) {
        const a = agentSpecs[0]!.id, b = agentSpecs[1]!.id;
        const qCells: Array<{ rater_a: string; rater_b: string }> = [];
        const rCells: Array<{ rater_a: string; rater_b: string }> = [];
        let qOk = 0, qN = 0, rOk = 0, rN = 0;
        for (const pid of patientIds) {
          const aDraft = readDraft(agentDraftPath(pilot.run_id, pid, a));
          const bDraft = readDraft(agentDraftPath(pilot.run_id, pid, b));
          if (!aDraft || !bDraft) continue;
          const bQByQid = new Map((bDraft.question_answers ?? []).map((q) => [q.question_id, q]));
          for (const aq of aDraft.question_answers ?? []) {
            const bq = bQByQid.get(aq.question_id);
            if (!bq) continue;
            qN++;
            if (JSON.stringify(normalize(aq.answer)) === JSON.stringify(normalize(bq.answer))) qOk++;
            qCells.push({
              rater_a: JSON.stringify(normalize(aq.answer)),
              rater_b: JSON.stringify(normalize(bq.answer)),
            });
          }
          const bVByRid = new Map((bDraft.rule_verdicts ?? []).map((v) => [v.rule_id, v]));
          for (const av of aDraft.rule_verdicts ?? []) {
            const bv = bVByRid.get(av.rule_id);
            if (!bv) continue;
            rN++;
            if (av.verdict === bv.verdict) rOk++;
            rCells.push({ rater_a: av.verdict, rater_b: bv.verdict });
          }
        }
        const qK = qCells.length >= 2 ? cohensKappa(qCells) : null;
        const rK = rCells.length >= 2 ? cohensKappa(rCells) : null;
        interAgent = {
          agent_a: a, agent_b: b,
          question_agreement_rate: qN > 0 ? qOk / qN : 0,
          rule_agreement_rate:     rN > 0 ? rOk / rN : 0,
          question_kappa: (qK !== null && Number.isFinite(qK)) ? qK : null,
          rule_kappa:     (rK !== null && Number.isFinite(rK)) ? rK : null,
        };
      }

      // Suppress lint complaints about path being unused-ish (cleanup).
      void path; void computePerQuestionMetrics; void computePerRuleMetrics;

      return {
        ok: true,
        task_id: p.taskId,
        iter_id: p.iterId,
        run_id: pilot.run_id,
        n_patients: patientIds.length,
        per_agent: perAgent,
        inter_agent: interAgent,
      };
    },
  },
];
