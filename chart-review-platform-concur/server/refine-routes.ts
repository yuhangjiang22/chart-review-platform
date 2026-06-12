// refine-routes.ts — self-refinement.
//
// GET /api/refine/:taskId/:iterId/candidates?session_id=  (Task S1, read-only)
//   → the attributed, clustered agent-vs-human disagreement set (the ① data of
//     the proposal card). Session-scoped (session_id required, like the other
//     review routes). Gates on phenotype task_kind — NER/adherence return an
//     `unsupported` marker (later increments).
//
// POST /api/refine/:taskId/:iterId/propose?session_id=  (Task S2)
//   body { field_id } → run the REFINER on that field's cluster (filtered to
//     guideline_gap + true_ambiguity) and return the transparent proposal card:
//     ① wrong examples, ② gap_summary, ③ proposed_rule_text, rationale, and a
//     leakage_warning when the rule smells like memorization. No ④ (held-out
//     Δκ) yet — that's S3. Session-scoped + phenotype-gated like candidates.
//
// candidates is read-only; propose makes one LLM call but no writes (the human
// applies the card via PUT /api/tasks/:taskId/criteria/:fieldId). See
// server/lib/refine/{candidates,propose}.ts.

import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "@chart-review/tasks";
import { collectRefinementCandidates } from "./lib/refine/candidates.js";
import { proposeRubricEdit } from "./lib/refine/propose.js";

/** The attributions that feed refinement (safeguard #1: never agent_error,
 *  never unjudged). Mirrors the plan's filter. */
const REFINABLE = new Set(["guideline_gap", "true_ambiguity"]);

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

export const refineRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/refine/:taskId/:iterId/candidates",
    handler: async (_b, _r, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);

      const sessionId = query.get("session_id");
      if (!sessionId) throw httpErr(400, "session_id is required");

      const taskKind = task.task_kind ?? "phenotype";
      if (taskKind !== "phenotype") {
        // NER/adherence are later increments. Surface a 400 with an
        // `unsupported` marker rather than a silent empty result.
        throw httpErr(
          400,
          `self-refinement supports phenotype tasks only; ${p.taskId} is ${taskKind}`,
        );
      }

      return collectRefinementCandidates({
        sessionId,
        taskId: p.taskId,
        iterId: p.iterId,
      });
    },
  },

  {
    method: "POST",
    pattern: "/api/refine/:taskId/:iterId/propose",
    handler: async (body, _r, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);

      const sessionId = query.get("session_id");
      if (!sessionId) throw httpErr(400, "session_id is required");

      const taskKind = task.task_kind ?? "phenotype";
      if (taskKind !== "phenotype") {
        throw httpErr(
          400,
          `self-refinement supports phenotype tasks only; ${p.taskId} is ${taskKind}`,
        );
      }

      const fieldId = (body as { field_id?: unknown } | null)?.field_id;
      if (typeof fieldId !== "string" || !fieldId.trim()) {
        throw httpErr(400, "field_id is required");
      }

      // Reuse the S1 collector, then pick this field's cluster.
      const candidates = collectRefinementCandidates({
        sessionId,
        taskId: p.taskId,
        iterId: p.iterId,
      });
      const cluster = candidates.clusters.find((c) => c.field_id === fieldId);
      if (!cluster) {
        throw httpErr(404, `no disagreement cluster for field ${fieldId}`);
      }
      if (!cluster.criterion_def) {
        throw httpErr(
          400,
          `field ${fieldId} has no criterion definition to refine`,
        );
      }

      // Safeguard #1: refine ONLY on guideline_gap + true_ambiguity. Exclude
      // agent_error (don't fix the rubric for the model's mistakes) and
      // unjudged (run the judge first).
      const gapExamples = cluster.examples.filter((e) =>
        REFINABLE.has(e.classification_hint),
      );
      if (gapExamples.length === 0) {
        throw httpErr(400, "no guideline-gap disagreements for this field");
      }

      const out = await proposeRubricEdit({
        taskId: p.taskId,
        fieldId,
        criterionDef: cluster.criterion_def,
        examples: gapExamples,
      });
      if (!out.ok || !out.proposal) {
        throw httpErr(502, out.error ?? "refiner failed");
      }

      return {
        field_id: fieldId,
        criterion_def: cluster.criterion_def,
        examples: gapExamples, // ① — gap-tagged only
        gap_summary: out.proposal.gap_summary, // ②
        proposed_rule_text: out.proposal.proposed_rule_text, // ③
        rationale: out.proposal.rationale,
        ...(out.proposal.leakage_warning
          ? { leakage_warning: out.proposal.leakage_warning }
          : {}),
        model: out.model,
        cost_usd: out.cost_usd,
        duration_ms: out.duration_ms,
      };
    },
  },
];
