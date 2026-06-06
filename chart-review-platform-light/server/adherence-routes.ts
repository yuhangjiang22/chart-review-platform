// Adherence-task server routes (Phase 3).
//
// Companion to entity-type-guidance-routes.ts (NER) and the phenotype
// criterion routes. Surfaces the question framework + rule definitions
// of an adherence task to the Studio's PhaseAdherenceAuthor pane, plus
// reviewer-side accept / override actions for the AdherenceReview pane.
//
// All routes guard on task.task_kind === "adherence" so a misrouted
// request to a phenotype/NER task fails fast with a 400.
//
// Routes:
//
//   GET   /api/tasks/:taskId/adherence
//     → { questions_by_tier, rules, attribution_categories }
//
//   PATCH /api/tasks/:taskId/adherence/questions/:tier
//     body: { questions: QuestionDefinition[] }
//     Replaces references/questions/T<tier>_*.yaml content. Methodologist-gated.
//
//   PATCH /api/tasks/:taskId/adherence/rules/:filename
//     body: { rules: RuleDefinition[] }
//     Replaces references/rules/<filename>.yaml content. Methodologist-gated.
//
//   POST  /api/reviews/:patientId/:taskId/adherence/question-answer
//     body: { question_id, answer, source? }
//     Reviewer accepts / overrides one question answer. Also bumps
//     validated_questions to mark it adjudicated.
//
//   POST  /api/reviews/:patientId/:taskId/adherence/rule-verdict
//     body: { rule_id, verdict, attribution?, rationale? }
//     Reviewer overrides one rule verdict. Marks validated_rules.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { guidelineDir } from "./lib/domain/rubric/index.js";
import { mutate as mutateReviewState } from "@chart-review/domain-review";
import {
  loadAdherenceSkill,
  type QuestionDefinition,
} from "@chart-review/pipeline-extract-adherence";
import type { RuleDefinition } from "@chart-review/rule-engine";
import type { QuestionAnswer, RuleVerdict, AttributionCategory } from "@chart-review/platform-types";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function adherenceTaskOrFail(taskId: string): ReturnType<typeof loadCompiledTask> {
  const task = loadCompiledTask(taskId);
  if (!task) throw httpErr(404, `task ${taskId} not found`);
  if (task.task_kind !== "adherence") {
    throw httpErr(
      400,
      `task ${taskId} is not an adherence task (task_kind=${task.task_kind ?? "phenotype"})`,
    );
  }
  return task;
}

function questionsTierPath(taskId: string, tier: number): string {
  if (!Number.isInteger(tier) || tier < 0 || tier > 9) {
    throw httpErr(400, `invalid tier: ${tier}`);
  }
  return path.join(
    guidelineDir(taskId), "references", "questions", `T${tier}.yaml`,
  );
}

function rulesFilePath(taskId: string, filename: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(filename)) {
    throw httpErr(400, `invalid filename: ${filename}`);
  }
  return path.join(
    guidelineDir(taskId), "references", "rules", `${filename}.yaml`,
  );
}

function writeYaml<T>(filePath: string, content: T): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(content));
}

export const adherenceRoutes: RouteEntry[] = [
  // ── Authoring (methodologist) ─────────────────────────────────────────────

  {
    method: "GET", pattern: "/api/tasks/:taskId/adherence",
    handler: async (_b, _r, p) => {
      adherenceTaskOrFail(p.taskId);
      const skill = loadAdherenceSkill(p.taskId);
      const questions_by_tier: Record<number, QuestionDefinition[]> = {};
      for (const [tier, qs] of skill.questions_by_tier) {
        questions_by_tier[tier] = qs;
      }
      return {
        ok: true,
        task_id: p.taskId,
        questions_by_tier,
        rules: skill.rules,
        attribution_categories: skill.attribution_categories,
      };
    },
  },

  {
    method: "PATCH", pattern: "/api/tasks/:taskId/adherence/questions/:tier",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!isMethodologist(reviewerId)) {
        throw httpErr(403, "editing adherence questions requires methodologist privilege");
      }
      adherenceTaskOrFail(p.taskId);
      const tier = Number(p.tier);
      const next = (body ?? {}) as { questions?: QuestionDefinition[] };
      if (!Array.isArray(next.questions)) {
        throw httpErr(400, "body.questions must be an array");
      }
      // Lightweight validation: every question must have id + text + tier matching the URL.
      for (const q of next.questions) {
        if (!q.question_id || typeof q.question_id !== "string") {
          throw httpErr(400, `question missing question_id`);
        }
        if (typeof q.text !== "string" || q.text.length === 0) {
          throw httpErr(400, `question ${q.question_id} missing text`);
        }
        if (q.tier !== tier) {
          throw httpErr(400, `question ${q.question_id} tier=${q.tier} does not match URL tier=${tier}`);
        }
      }
      const fp = questionsTierPath(p.taskId, tier);
      writeYaml(fp, { questions: next.questions });
      return { ok: true, task_id: p.taskId, tier, count: next.questions.length, path: fp };
    },
  },

  {
    method: "PATCH", pattern: "/api/tasks/:taskId/adherence/rules/:filename",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!isMethodologist(reviewerId)) {
        throw httpErr(403, "editing adherence rules requires methodologist privilege");
      }
      adherenceTaskOrFail(p.taskId);
      const next = (body ?? {}) as { rules?: RuleDefinition[] };
      if (!Array.isArray(next.rules)) {
        throw httpErr(400, "body.rules must be an array");
      }
      for (const r of next.rules) {
        if (!r.rule_id || typeof r.rule_id !== "string") {
          throw httpErr(400, "rule missing rule_id");
        }
        if (typeof r.verdict_if !== "string" || r.verdict_if.length === 0) {
          throw httpErr(400, `rule ${r.rule_id} missing verdict_if`);
        }
      }
      const fp = rulesFilePath(p.taskId, p.filename);
      writeYaml(fp, { rules: next.rules });
      return { ok: true, task_id: p.taskId, filename: p.filename, count: next.rules.length, path: fp };
    },
  },

  // ── Reviewer actions ──────────────────────────────────────────────────────

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/adherence/question-answer",
    handler: async (body, req, p) => {
      const task = adherenceTaskOrFail(p.taskId);
      const reviewerId = readReviewerFromRequest(req);
      const b = (body ?? {}) as Partial<QuestionAnswer> & { question_id?: string };
      if (!b.question_id) throw httpErr(400, "question_id required");
      // Resolve tier from the skill so the caller doesn't have to re-send it.
      const skill = loadAdherenceSkill(p.taskId);
      let tier: number | undefined;
      for (const [t, qs] of skill.questions_by_tier) {
        if (qs.some((q) => q.question_id === b.question_id)) { tier = t; break; }
      }
      if (tier === undefined) {
        throw httpErr(404, `question ${b.question_id} not found in task ${p.taskId}`);
      }
      const result = mutateReviewState(p.patientId, task!, "reviewer", (state) => {
        state.task_kind = "adherence";
        const qa = state.question_answers ?? [];
        const idx = qa.findIndex((a) => a.question_id === b.question_id);
        const patched: QuestionAnswer = {
          question_id: b.question_id!,
          tier: tier!,
          answer: (b.answer ?? null) as QuestionAnswer["answer"],
          confidence: b.confidence,
          evidence: b.evidence,
          reasoning: b.reasoning,
          verifier_status: b.verifier_status,
          source: "reviewer",
          ts: new Date().toISOString(),
        };
        if (idx >= 0) qa[idx] = patched;
        else qa.push(patched);
        state.question_answers = qa;
        const validated = new Set(state.validated_questions ?? []);
        validated.add(b.question_id!);
        state.validated_questions = [...validated];
      });
      void reviewerId;
      return { ok: true, version: result.version };
    },
  },

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/adherence/rule-verdict",
    handler: async (body, req, p) => {
      const task = adherenceTaskOrFail(p.taskId);
      const reviewerId = readReviewerFromRequest(req);
      const b = (body ?? {}) as {
        rule_id?: string;
        verdict?: RuleVerdict["verdict"];
        attribution?: AttributionCategory;
        rationale?: string;
      };
      if (!b.rule_id) throw httpErr(400, "rule_id required");
      if (b.verdict !== "CONCORDANT" && b.verdict !== "NON_CONCORDANT" && b.verdict !== "EXCLUDED") {
        throw httpErr(400, "verdict must be CONCORDANT | NON_CONCORDANT | EXCLUDED");
      }
      const result = mutateReviewState(p.patientId, task!, "reviewer", (state) => {
        state.task_kind = "adherence";
        const verdicts = state.rule_verdicts ?? [];
        const idx = verdicts.findIndex((v) => v.rule_id === b.rule_id);
        const patched: RuleVerdict = {
          rule_id: b.rule_id!,
          verdict: b.verdict!,
          attribution: b.attribution,
          rationale: b.rationale,
          source: "reviewer",
          ts: new Date().toISOString(),
        };
        if (idx >= 0) verdicts[idx] = patched;
        else verdicts.push(patched);
        state.rule_verdicts = verdicts;
        const validated = new Set(state.validated_rules ?? []);
        validated.add(b.rule_id!);
        state.validated_rules = [...validated];
      });
      void reviewerId;
      return { ok: true, version: result.version };
    },
  },
];
