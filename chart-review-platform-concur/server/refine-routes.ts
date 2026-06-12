// refine-routes.ts — self-refinement.
//
// GET /api/refine/:taskId/:iterId/candidates?session_id=  (Task S1, read-only)
//   → the attributed, clustered agent-vs-human disagreement set (the ① data of
//     the proposal card). Session-scoped (session_id required, like the other
//     review routes). Gates on phenotype task_kind — NER/adherence return an
//     `unsupported` marker (later increments).
//
// POST /api/refine/:taskId/:iterId/propose?session_id=  (Tasks S2 + S3)
//   body { field_id } → run the REFINER on that field's cluster and return the
//     transparent proposal card:
//     ① wrong examples, ② gap_summary, ③ proposed_rule_text, rationale, a
//     leakage_warning when the rule smells like memorization, and (S3) the ④
//     held-out Δ.
//
//   S3 careful core: the field's validated patients are split deterministically
//   into a refine set + a held-out set (held-out hidden from the refiner via
//   the candidate collector's examplePatientFilter). The refiner sees only
//   refine-set disagreements; then we re-score the held-out patients on this
//   criterion with a method-constant single-criterion extractor under the
//   CURRENT vs CANDIDATE (current + proposed rule) text and attach
//   `holdout: { delta, agreement_old, agreement_new, n_fixed, n_regressed,
//   heldout_n }` — or `{ insufficient_holdout, heldout_n }` when too few
//   held-out patients to claim a number. Session-scoped + phenotype-gated.
//
// candidates is read-only; propose makes LLM calls (1 refiner + 2×held-out
// extractions) but no writes (the human applies the card via
// PUT /api/tasks/:taskId/criteria/:fieldId). See
// server/lib/refine/{candidates,propose,holdout}.ts.

import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "@chart-review/tasks";
import { collectRefinementCandidates } from "./lib/refine/candidates.js";
import { proposeRubricEdit } from "./lib/refine/propose.js";
import {
  splitValidatedPatients,
  rescoreCriterionOnHeldout,
} from "./lib/refine/holdout.js";

/** The attributions that feed refinement (safeguard #1: never agent_error,
 *  never unjudged). Mirrors the plan's filter. */
const REFINABLE = new Set(["guideline_gap", "true_ambiguity"]);

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

/** Strip a single leading markdown bullet (`- ` / `* `) from the proposed rule
 *  so the candidate text (and Apply's append) doesn't double-bullet — the
 *  client's Apply prepends its own `- `. Idempotent on already-clean text. */
function stripLeadingBullet(s: string): string {
  return s.replace(/^\s*[-*]\s+/, "");
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

      // ── S3 SPLIT ──────────────────────────────────────────────────────────
      // First pass (unfiltered): get this field's full validated gold so we can
      // partition its patients into refine + held-out. gold_by_field spans all
      // validated patients regardless of any example filter.
      const goldPass = collectRefinementCandidates({
        sessionId,
        taskId: p.taskId,
        iterId: p.iterId,
      });
      const fieldGold = goldPass.gold_by_field[fieldId] ?? {};
      const { refine: refineSet, heldout: heldoutSet } = splitValidatedPatients(
        Object.keys(fieldGold),
      );

      // Second pass (filtered): the refiner sees disagreements ONLY from the
      // refine set — held-out patients' mismatches are excluded so the proof is
      // truly out-of-sample.
      const candidates = collectRefinementCandidates({
        sessionId,
        taskId: p.taskId,
        iterId: p.iterId,
        examplePatientFilter: new Set(refineSet),
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
      // unjudged (run the judge first). These are already refine-set-only.
      const gapExamples = cluster.examples.filter((e) =>
        REFINABLE.has(e.classification_hint),
      );
      if (gapExamples.length === 0) {
        throw httpErr(
          400,
          "no guideline-gap disagreements for this field in the refine set " +
            "(held-out patients are reserved for validation and not shown to the refiner)",
        );
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

      // Cosmetic (folded S2 fix): strip a leading bullet so the candidate text
      // and the client's Apply (which prepends its own `- `) don't double-bullet.
      const proposedRuleText = stripLeadingBullet(out.proposal.proposed_rule_text);

      // ── S3 ④ HELD-OUT Δ ───────────────────────────────────────────────────
      // Method-constant re-score: same single-criterion extractor on the
      // held-out patients under the CURRENT text vs the CANDIDATE text (current
      // + appended rule). Δ isolates the rule's effect; the absolute is a proxy
      // for the full pipeline. rescoreCriterionOnHeldout returns
      // insufficient_holdout when the held-out set is too small to claim a Δ.
      const candidateText = `${cluster.criterion_def}\n\n- ${proposedRuleText}`;
      const holdout = await rescoreCriterionOnHeldout({
        taskId: p.taskId,
        fieldId,
        criterionTextOld: cluster.criterion_def,
        criterionTextNew: candidateText,
        heldoutPatients: heldoutSet,
        gold: fieldGold,
        answerEnum: cluster.answer_enum ?? undefined,
      });

      const holdoutForCard = holdout.insufficient_holdout
        ? { insufficient_holdout: true as const, heldout_n: holdout.heldout_n }
        : {
            delta: holdout.delta,
            agreement_old: holdout.agreement_old,
            agreement_new: holdout.agreement_new,
            n_fixed: holdout.n_fixed,
            n_regressed: holdout.n_regressed,
            heldout_n: holdout.heldout_n,
            scored_n: holdout.scored_n,
          };

      return {
        field_id: fieldId,
        criterion_def: cluster.criterion_def,
        examples: gapExamples, // ① — gap-tagged, refine-set only
        gap_summary: out.proposal.gap_summary, // ②
        proposed_rule_text: proposedRuleText, // ③ (bullet-stripped)
        rationale: out.proposal.rationale,
        ...(out.proposal.leakage_warning
          ? { leakage_warning: out.proposal.leakage_warning }
          : {}),
        holdout: holdoutForCard, // ④
        refine_n: refineSet.length,
        model: out.model,
        cost_usd:
          (out.cost_usd ?? 0) +
          (holdout.insufficient_holdout ? 0 : holdout.cost_usd ?? 0) || out.cost_usd,
        duration_ms: out.duration_ms,
      };
    },
  },
];
