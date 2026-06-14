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
import { runErrorAnalysisBatch } from "./lib/refine/error-analysis.js";
import {
  applyRefinement,
  readRefinementLog,
  revertRefinement,
  type RefinementCardSnapshot,
} from "./lib/refine/provenance.js";
import { readReviewerFromRequest } from "./auth.js";
import { collectNerRefinementCandidates } from "./lib/refine/ner-candidates.js";
import { runNerErrorAnalysisBatch } from "./lib/refine/ner-error-analysis.js";

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
    // Run the model-vs-human ERROR-ANALYSIS pass over the iter's mismatches the
    // agent-vs-agent judge never attributed (the systematic-gap case). Persists
    // error_analyses.json so subsequent /candidates + /propose pick up the
    // guideline_gap / true_ambiguity attribution. Session-scoped, phenotype-only.
    // Makes one LLM call per unattributed mismatch cell.
    method: "POST",
    pattern: "/api/refine/:taskId/:iterId/analyze-errors",
    handler: async (_body, _r, p, query) => {
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

      const result = await runErrorAnalysisBatch({
        sessionId,
        taskId: p.taskId,
        iterId: p.iterId,
      });
      if (!result.ok) throw httpErr(400, result.error ?? "error-analysis batch failed");
      return {
        cells_analyzed: result.cells_analyzed,
        cells_failed: result.cells_failed,
        cells_skipped: result.cells_skipped,
        analyses: result.file?.analyses ?? [],
      };
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

  {
    // NER: entity-type span-disagreement clusters (agent vs reviewer-validated
    // spans), the ① data for entity-type guidance refinement. ner-gated.
    method: "GET",
    pattern: "/api/refine/:taskId/:iterId/ner-candidates",
    handler: async (_b, _r, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      const sessionId = query.get("session_id");
      if (!sessionId) throw httpErr(400, "session_id is required");
      const result = collectNerRefinementCandidates({ sessionId, taskId: p.taskId, iterId: p.iterId });
      if (result.unsupported) throw httpErr(400, result.unsupported.reason);
      return result;
    },
  },

  {
    // NER: run the model-vs-human error-analysis pass over the entity-type
    // clusters → attributes each (guideline_gap / true_ambiguity / agent_error)
    // and persists ner_error_analyses.json. One LLM call per entity type.
    method: "POST",
    pattern: "/api/refine/:taskId/:iterId/ner-analyze-errors",
    handler: async (_b, _r, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      const sessionId = query.get("session_id");
      if (!sessionId) throw httpErr(400, "session_id is required");
      const result = await runNerErrorAnalysisBatch({ sessionId, taskId: p.taskId, iterId: p.iterId });
      if (!result.ok) throw httpErr(400, result.error ?? "ner error-analysis failed");
      return {
        cells_analyzed: result.cells_analyzed,
        cells_failed: result.cells_failed,
        analyses: result.analyses,
      };
    },
  },

  {
    // Apply a proposal card: append ③ to the criterion's extraction guidance AND
    // record the whole card (①②③④) + prior text as revertable provenance.
    // Phenotype-only, session-scoped. The reviewer (human) applies — this just
    // performs the edit + logs it.
    method: "POST",
    pattern: "/api/refine/:taskId/:iterId/apply",
    handler: async (body, req, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      const taskKind = task.task_kind ?? "phenotype";
      if (taskKind !== "phenotype") {
        throw httpErr(400, `self-refinement supports phenotype tasks only; ${p.taskId} is ${taskKind}`);
      }
      const b = (body ?? {}) as {
        field_id?: unknown;
        proposed_rule_text?: unknown;
        card?: Partial<RefinementCardSnapshot>;
      };
      if (typeof b.field_id !== "string" || !b.field_id.trim()) {
        throw httpErr(400, "field_id is required");
      }
      if (typeof b.proposed_rule_text !== "string" || !b.proposed_rule_text.trim()) {
        throw httpErr(400, "proposed_rule_text is required");
      }
      // Trim the card to the stored snapshot shape (don't persist the full
      // criterion_def / model / cost fields).
      const card: RefinementCardSnapshot | undefined = b.card
        ? {
            examples: Array.isArray(b.card.examples) ? b.card.examples.slice(0, 20) : [],
            gap_summary: typeof b.card.gap_summary === "string" ? b.card.gap_summary : "",
            rationale: typeof b.card.rationale === "string" ? b.card.rationale : "",
            holdout: b.card.holdout,
            refine_n: typeof b.card.refine_n === "number" ? b.card.refine_n : undefined,
          }
        : undefined;
      try {
        const entry = applyRefinement({
          taskId: p.taskId,
          fieldId: b.field_id,
          ruleText: b.proposed_rule_text,
          card,
          appliedBy: readReviewerFromRequest(req) ?? "reviewer",
          iterId: p.iterId,
          sessionId: query.get("session_id") ?? undefined,
        });
        return { ok: true, entry };
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
    },
  },

  {
    // The criterion's refinement history (provenance): which rules were added to
    // fix which cases, the held-out Δ, and whether each was reverted.
    method: "GET",
    pattern: "/api/refine/:taskId/log",
    handler: async (_b, _r, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      const fieldId = query.get("field_id") ?? undefined;
      return { entries: readRefinementLog(p.taskId, fieldId) };
    },
  },

  {
    // Revert a previously-applied edit (restore the pre-apply guidance). Flags
    // `intervening_edit` when the guidance changed since the apply.
    method: "POST",
    pattern: "/api/refine/:taskId/revert",
    handler: async (body, req, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      const entryId = (body as { entry_id?: unknown } | null)?.entry_id;
      if (typeof entryId !== "string" || !entryId.trim()) {
        throw httpErr(400, "entry_id is required");
      }
      try {
        const { entry, intervening_edit } = revertRefinement({
          taskId: p.taskId,
          entryId,
          by: readReviewerFromRequest(req) ?? "reviewer",
        });
        return { ok: true, entry, intervening_edit };
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
    },
  },
];
