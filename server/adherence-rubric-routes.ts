// adherence-rubric-routes.ts — the editable adherence QUESTION rubric, for the
// AUTHOR pane. Mirrors the phenotype rubric routes (GET /rubric + PUT
// /criteria/:fieldId): the methodologist edits questions directly here, while
// the refinement agent proposes edits on the PERFORMANCE pane — both write the
// same tier-YAML question bundles (rule verdicts are deterministic and not
// editable here).

import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
import { setAdherenceQuestionFields } from "./lib/refine/adherence-provenance.js";
import { snapshotAfterEdit } from "./lib/rubric-edit-snapshot.js";

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

function requireAdherence(taskId: string): void {
  const task = loadCompiledTask(taskId);
  if (!task) throw httpErr(404, `task ${taskId} not found`);
  if ((task.task_kind ?? "phenotype") !== "adherence") {
    throw httpErr(400, `task ${taskId} is not an adherence task (task_kind=${task.task_kind ?? "phenotype"})`);
  }
}

export const adherenceRubricRoutes: RouteEntry[] = [
  {
    // The full question rubric, tier-ordered, for the editable AUTHOR pane.
    method: "GET",
    pattern: "/api/tasks/:taskId/adherence-rubric",
    handler: async (_b, _r, p, query) => {
      requireAdherence(p.taskId);
      // Read the session's fork when a session is in context so AUTHOR edits +
      // applied refinements are reflected (else the baseline).
      const skill = loadAdherenceSkill(p.taskId, query.get("session_id") ?? undefined);
      const questions: Array<{
        question_id: string;
        tier: number;
        text: string;
        retrieval_hints: string;
        answer_schema?: unknown;
        depends_on?: string[];
      }> = [];
      const tiers = [...skill.questions_by_tier.keys()].sort((a, b) => a - b);
      for (const tier of tiers) {
        for (const q of skill.questions_by_tier.get(tier) ?? []) {
          questions.push({
            question_id: q.question_id,
            tier,
            text: typeof q.text === "string" ? q.text : "",
            retrieval_hints: typeof q.retrieval_hints === "string" ? q.retrieval_hints : "",
            answer_schema: q.answer_schema,
            depends_on: q.depends_on,
          });
        }
      }
      return { task_id: p.taskId, questions };
    },
  },

  {
    // Edit one question's authorable fields (text / retrieval_hints). Sibling
    // questions in the bundle are untouched. Not logged to the refinement
    // provenance (direct human edit), matching PUT /criteria.
    method: "PUT",
    pattern: "/api/tasks/:taskId/adherence-questions/:questionId",
    handler: async (body, _r, p, query) => {
      requireAdherence(p.taskId);
      const sessionId = query.get("session_id") ?? undefined;
      const b = (body ?? {}) as { text?: unknown; retrieval_hints?: unknown };
      const fields: { text?: string; retrieval_hints?: string } = {};
      if (b.text !== undefined) {
        if (typeof b.text !== "string") throw httpErr(400, "text must be a string");
        fields.text = b.text;
      }
      if (b.retrieval_hints !== undefined) {
        if (typeof b.retrieval_hints !== "string") throw httpErr(400, "retrieval_hints must be a string");
        fields.retrieval_hints = b.retrieval_hints;
      }
      if (fields.text === undefined && fields.retrieval_hints === undefined) {
        throw httpErr(400, "provide at least one of: text, retrieval_hints");
      }
      try {
        setAdherenceQuestionFields(p.taskId, p.questionId, fields, sessionId);
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
      // A direct AUTHOR edit is a rubric change → snapshot a version on the same
      // (session fork or baseline) root, mirroring PUT /criteria.
      snapshotAfterEdit({ taskId: p.taskId, sessionId, source: "author-edit", by: "reviewer" });
      return { ok: true };
    },
  },
];
