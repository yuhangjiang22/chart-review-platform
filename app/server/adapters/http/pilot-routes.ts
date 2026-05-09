/**
 * adapters/http/pilot-routes — HTTP adapter for Pilot Iter lifecycle (#11).
 *
 * A pilot iteration is a tagged batch run with extra lifecycle state.
 * guidelines/<task_id>/pilots/iter_NNN/manifest.json carries the iter
 * number, run_id, guideline_sha at start, state, notes.
 *
 * Routes registered:
 *   POST   /api/pilots/:taskId                              — start pilot
 *   GET    /api/pilots/:taskId                              — list iters
 *   GET    /api/pilots/:taskId/stats                        — per-iter stats
 *   GET    /api/pilots/:taskId/eligibility                  — refinement-loop eligibility
 *   GET    /api/pilots/:taskId/rerun-plan-preview           — rerun plan pre-flight
 *   GET    /api/pilots/:taskId/stop-rule                    — stop-rule graduation gate
 *   GET    /api/pilots/:taskId/:iterId                      — iter detail
 *   POST   /api/pilots/:taskId/:iterId/critique             — self-critique
 *   GET    /api/pilots/:taskId/:iterId/critique             — read critique
 *   GET    /api/pilots/:taskId/:iterId/disagreements        — disagreements
 *   GET    /api/pilots/:taskId/:iterId/adjudications        — list adjudications
 *   POST   /api/pilots/:taskId/:iterId/adjudications        — append adjudication
 *   GET    /api/pilots/:taskId/:iterId/revisits             — revisits (changed criteria)
 *   POST   /api/pilots/:taskId/:iterId/revisits/bulk-keep   — bulk-bump revisits
 *   PATCH  /api/pilots/:taskId/:iterId                      — update state/notes
 */

import express, { Router } from "express";
import fs from "fs";
import path from "path";
import {
  startPilotIteration,
  listPilotIterations,
  getPilotManifest,
  getPilotCritique,
  selfCritiquePilot,
  setPilotState,
  fireAutoCritique,
  pilotIterationStats,
  readPrimaryCriterionIds,
  extractDisagreements,
  computeIterAccuracy,
  persistIterAccuracy,
  writeIterReport,
  transitionIterToRevising,
  snapshotCriterionHashesSync,
  type PilotState,
} from "../../domain/iter/index.js";
import { evaluateStopRule } from "../../domain/iter/stop-rule.js";
import { loadCriteria, guidelineDir, phenotypeSkillDir } from "../../domain/rubric/index.js";
import { readCohortSampling } from "../../domain/cohort/index.js";
import {
  writeAdjudication,
  listAdjudications,
  type Adjudication,
} from "../../adjudications.js";
import { criterionSchemaHash, computeRerunPlan } from "../../criterion-hash.js";
import { computeEligibility, type IterSnapshot } from "../../eligibility.js";
import { reviewerIdOf, isMethodologist } from "../../auth.js";
import { getRunManifest, getRunStatus, type RunStatus } from "../../infra/batch-run/index.js";
import {
  computeRevisitsForIter,
  bulkKeepRevisits,
} from "../../derived-adjudications/revisits.js";
import {
  runJudgeBatch,
  readJudgeAnalyses,
  isJudgeBatchRunning,
  lockJudgeBatch,
  unlockJudgeBatch,
} from "../../judge-batch.js";

export interface PilotRouterOptions {
  /**
   * Optional callback fired on every batch-run status update. Server.ts
   * passes its WebSocket broadcaster so pilot runs stream progress to
   * connected clients.
   */
  onRunStatus?: (s: RunStatus) => void;
}

export function pilotRouter(opts: PilotRouterOptions = {}): Router {
  const router = Router();

  router.post("/api/pilots/:taskId", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "starting a pilot requires methodologist privilege" });
    }
    const { patient_ids, notes, max_concurrency, max_turns_per_patient, cost_cap_usd, agent_specs } = req.body ?? {};
    if (!Array.isArray(patient_ids) || patient_ids.length === 0) {
      return res.status(400).json({ error: "non-empty patient_ids required" });
    }
    try {
      const result = startPilotIteration({
        task_id: req.params.taskId,
        patient_ids,
        started_by: reviewerId,
        notes,
        max_concurrency,
        max_turns_per_patient,
        cost_cap_usd,
        agent_specs,
        onRunStatus: opts.onRunStatus,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/pilots/:taskId", (req, res) => {
    res.json(listPilotIterations(req.params.taskId));
  });

  // Per-iteration stats for compare view (#37). Must be declared BEFORE
  // /:iterId so Express matches "stats" as a literal path, not as iterId.
  router.get("/api/pilots/:taskId/stats", (req, res) => {
    res.json(pilotIterationStats(req.params.taskId));
  });

  // Refinement-loop eligibility: computes whether the guideline is ready to
  // scale, based on accuracy blocks in each completed iter's critique.json.
  router.get("/api/pilots/:taskId/eligibility", (req, res) => {
    const { taskId } = req.params;
    const pilots = listPilotIterations(taskId);
    const iters: IterSnapshot[] = pilots
      .filter((p) => p.state === "complete")
      .map((p) => {
        const full = getPilotCritique(taskId, p.iter_id);
        const acc = (full as any)?.accuracy;
        if (!acc) return null;
        return {
          iter_id: p.iter_id,
          per_criterion: acc.per_criterion,
          override_count: acc.override_count,
        };
      })
      .filter((x): x is IterSnapshot => x !== null)
      .sort((a, b) => a.iter_id.localeCompare(b.iter_id));
    res.json(computeEligibility(iters));
  });

  // Rerun-plan preview — computes which criteria will rerun vs carry over
  // WITHOUT starting the pilot. Used by the UI to show a pre-flight summary.
  // Must be declared BEFORE /:iterId to avoid Express treating the literal
  // path segment "rerun-plan-preview" as an iterId.
  router.get("/api/pilots/:taskId/rerun-plan-preview", (req, res) => {
    const { taskId } = req.params as { taskId: string };

    // 1. Load current criteria and build hash map.
    const criteria = loadCriteria(taskId);
    const currentHashes: Record<string, string> = {};
    for (const c of criteria) {
      // Only leaf criteria (no derivation) participate in the rerun plan.
      if ((c as any).derivation != null) continue;
      currentHashes[c.field_id] = c.schema_hash ?? criterionSchemaHash(c as Record<string, unknown>);
    }

    // 2. Find the most recent prior pilot iteration.
    const allIters = listPilotIterations(taskId);
    // listPilotIterations returns newest-first.
    const priorIter = allIters.length > 0 ? allIters[0] : null;
    const priorManifest = priorIter
      ? { iter_id: priorIter.iter_id, criterion_schema_hashes: priorIter.criterion_schema_hashes }
      : null;

    // 3. Compute the rerun plan.
    const plan = computeRerunPlan(currentHashes, priorManifest);

    const priorHadCriterionHashes =
      priorManifest != null && priorManifest.criterion_schema_hashes != null;

    // 4. Cost estimate: ~$0.034 per (patient × criterion × agent) cell
    //    based on claude-haiku-4.5 baseline. We don't know agent count here,
    //    so we estimate per-cell and let the UI multiply by N agents.
    const COST_PER_CELL_USD = 0.034;
    const nRerun = plan.rerun_criteria.length;

    // Read dev_patient_ids from sampling.json for the count.
    let nPatients = 5; // safe fallback
    try {
      const cohort = readCohortSampling(taskId);
      if (cohort?.dev_patient_ids?.length) nPatients = cohort.dev_patient_ids.length;
    } catch { /* ignore */ }

    const estimatedCostPerAgent =
      nRerun > 0 ? +(nRerun * nPatients * COST_PER_CELL_USD).toFixed(2) : 0;

    const costBasis =
      nRerun === 0
        ? "no agent runs needed (all criteria carry over)"
        : `${nPatients} patients x ${nRerun} criteria x $${COST_PER_CELL_USD}/cell (haiku-4.5 baseline)`;

    res.json({
      task_id: taskId,
      prior_iter_id: priorIter?.iter_id ?? null,
      prior_had_criterion_hashes: priorHadCriterionHashes,
      carried_criteria: plan.carried_criteria,
      rerun_criteria: plan.rerun_criteria,
      estimated_cost_usd_per_agent: estimatedCostPerAgent,
      estimated_cost_basis: costBasis,
      n_patients: nPatients,
    });
  });

  router.get("/api/pilots/:taskId/:iterId", (req, res) => {
    const { taskId, iterId } = req.params as { taskId: string; iterId: string };
    const m = getPilotManifest(taskId, iterId);
    if (!m) return res.status(404).json({ error: "pilot iteration not found" });
    const critique = getPilotCritique(taskId, iterId);
    const platformRoot =
      process.env.CHART_REVIEW_PLATFORM_ROOT ?? path.resolve(process.cwd(), "..");
    const reviewsRootDir =
      process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(platformRoot, "reviews");

    // Truth source for who ran is the run manifest, not sampling.json — the
    // user may have picked a one-off list via the TRY-phase patient picker
    // that diverges from the curated dev cohort. Fall back to sampling for
    // legacy iters whose run manifest is missing.
    const runManifest = getRunManifest(m.run_id);
    const runStatus = getRunStatus(m.run_id);
    const patientIds: string[] =
      runManifest?.patient_ids
      ?? readCohortSampling(taskId)?.dev_patient_ids
      ?? [];

    const patient_status = patientIds.map((pid) => {
      // agent_done reflects the actual batch-run state, not whether the
      // drafts were imported into reviews/. Imports happen lazily; the
      // VALIDATE phase only needs to know the agent finished.
      const perPatient = runStatus?.per_patient?.[pid];
      const agentDone = perPatient?.state === "complete";

      const reviewPath = path.join(reviewsRootDir, pid, taskId, "review_state.json");
      let validated = false;
      let reviewerTouched = false;
      if (fs.existsSync(reviewPath)) {
        try {
          const state = JSON.parse(fs.readFileSync(reviewPath, "utf8")) as {
            review_status?: string;
            field_assessments?: Array<{ source?: string }>;
          };
          validated =
            state.review_status === "reviewer_validated"
            || state.review_status === "locked";
          reviewerTouched = (state.field_assessments ?? []).some((fa) => fa.source === "reviewer");
        } catch { /* ignore parse errors */ }
      }
      return {
        patient_id: pid,
        agent_done: agentDone,
        oracle_done: validated,
        in_progress: reviewerTouched && !validated,
      };
    });
    res.json({ manifest: m, critique, patient_status });
  });

  // Run self-critique on a pilot iteration. Reads imported review_state
  // for each patient in the pilot's run, clusters reviewer overrides via
  // the guideline-improvement skill, persists a critique record next to
  // the pilot manifest. Resulting proposals enter the standard rule
  // pipeline (RulesPanel).
  router.post("/api/pilots/:taskId/:iterId/critique", async (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "self-critique requires methodologist privilege" });
    }
    try {
      const { focus_criterion } = req.body ?? {};
      const taskId = req.params.taskId;
      const iterId = req.params.iterId;
      const result = await selfCritiquePilot({
        task_id: taskId,
        iter_id: iterId,
        ran_by: reviewerId,
        focus_criterion,
      });

      // Per-iter accuracy compute — runs alongside the critique clustering.
      const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT ?? path.resolve(process.cwd(), "..");
      try {
        const cohort = readCohortSampling(taskId);
        const primaryCriterionIds = readPrimaryCriterionIds(taskId);
        if (cohort && primaryCriterionIds.length > 0) {
          const accuracy = computeIterAccuracy({
            rootDir: platformRoot,
            taskId,
            iterId,
            cohortKind: "dev",
            patientIds: cohort.dev_patient_ids,
            primaryCriterionIds,
          });
          persistIterAccuracy(taskId, iterId, accuracy);
          writeIterReport(taskId, iterId, accuracy);
        }
      } catch (err) {
        console.error(`[refinement-loop] accuracy compute failed for ${taskId}/${iterId}:`, err);
      }

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/pilots/:taskId/:iterId/critique", (req, res) => {
    const r = getPilotCritique(req.params.taskId, req.params.iterId);
    if (!r) return res.status(404).json({ error: "no critique recorded yet" });
    res.json(r);
  });

  router.get("/api/pilots/:taskId/:iterId/disagreements", (req, res) => {
    const { taskId, iterId } = req.params;
    const fp = path.join(guidelineDir(taskId), "pilots", iterId, "disagreements.json");

    /**
     * Coerce a single disagreement record from a legacy on-disk shape to
     * the current AgentAnswerSlot shape.
     *
     * Pre-cluster-3 files have `answers: { agent_a: "yes", agent_b: "no" }`
     * (flat strings). Cluster-3+ files have
     * `answers: { agent_a: { value: "yes", status: "answered" } }`.
     * This shim makes legacy files safe for clients that type-check `status`.
     */
    function coerceLegacyDisagreement(d: any): any {
      if (!d?.answers) return d;
      for (const which of ["agent_a", "agent_b"] as const) {
        const v = d.answers[which];
        if (typeof v === "string") {
          d.answers[which] = { value: v, status: "answered" };
        } else if (v && typeof v === "object" && !("status" in v)) {
          d.answers[which] = { value: v.value ?? null, status: "answered" };
        }
      }
      return d;
    }

    if (fs.existsSync(fp)) {
      try {
        const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
        // The file is a DisagreementSummary object with a `disagreements` array.
        const coerced = {
          ...raw,
          disagreements: Array.isArray(raw.disagreements)
            ? raw.disagreements.map(coerceLegacyDisagreement)
            : [],
        };
        res.json(coerced);
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
      return;
    }
    // Fallback: compute on the fly if the disk file doesn't exist yet.
    try {
      const summary = extractDisagreements(taskId, iterId);
      res.json(summary);
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  router.get("/api/pilots/:taskId/:iterId/adjudications", (req, res) => {
    const dir = path.join(guidelineDir(req.params.taskId), "pilots", req.params.iterId);
    res.json({ adjudications: listAdjudications(dir) });
  });

  // ── LLM-as-judge: pre-screens disagreements + low-confidence cells ─────
  // POST kicks off an async batch run; GET reads the on-disk result.
  // Methodologist-only because it spends LLM tokens.
  router.post(
    "/api/pilots/:taskId/:iterId/judge",
    express.json(),
    (req, res) => {
      const reviewerId = reviewerIdOf(req);
      if (!isMethodologist(reviewerId)) {
        return res
          .status(403)
          .json({ error: "running judge requires methodologist privilege" });
      }
      const { taskId, iterId } = req.params;
      if (isJudgeBatchRunning(taskId, iterId)) {
        return res
          .status(409)
          .json({ ok: false, error: "judge batch already running for this iter" });
      }
      if (!lockJudgeBatch(taskId, iterId)) {
        return res
          .status(409)
          .json({ ok: false, error: "could not acquire judge batch lock" });
      }
      // Respond immediately; run the batch in the background.
      res.json({ ok: true, started: true, taskId, iterId });
      void runJudgeBatch({
        taskId,
        iterId,
        startedBy: reviewerId,
      })
        .then((result) => {
          console.log(
            `[judge-batch] ${taskId}/${iterId} done: ${result.cells_analyzed}/${result.cells_total} cells, ` +
              `$${result.total_cost_usd.toFixed(4)}, ${result.total_duration_ms}ms`,
          );
        })
        .catch((e) => {
          console.error(`[judge-batch] ${taskId}/${iterId} failed:`, e);
        })
        .finally(() => {
          unlockJudgeBatch(taskId, iterId);
        });
    },
  );

  router.get("/api/pilots/:taskId/:iterId/judge", (req, res) => {
    const { taskId, iterId } = req.params;
    const file = readJudgeAnalyses(taskId, iterId);
    const running = isJudgeBatchRunning(taskId, iterId);
    if (!file) {
      return res.json({ exists: false, running, analyses: [] });
    }
    res.json({ exists: true, running, ...file });
  });

  router.post("/api/pilots/:taskId/:iterId/adjudications", express.json(), (req, res) => {
    try {
      const dir = path.join(guidelineDir(req.params.taskId), "pilots", req.params.iterId);
      const body = req.body as Adjudication;
      if (!body.timestamp) body.timestamp = new Date().toISOString();
      writeAdjudication(dir, body);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Revisit list — surfaces every prior GT record on a criterion whose SHA
  // has changed since the record was committed. Methodologist's worklist
  // when re-running an edited criterion.
  router.get("/api/pilots/:taskId/:iterId/revisits", (req, res) => {
    const { taskId, iterId } = req.params;
    const result = computeRevisitsForIter({ taskId, iterId });
    res.json({ ok: true, ...result });
  });

  router.post(
    "/api/pilots/:taskId/:iterId/revisits/bulk-keep",
    express.json(),
    async (req, res) => {
      const { taskId } = req.params;
      const { field_id, patient_ids } = req.body ?? {};
      if (typeof field_id !== "string" || field_id.length === 0) {
        return res.status(400).json({ ok: false, error: "field_id required" });
      }
      const reviewerId = (req.headers["x-reviewer-id"] as string) ?? "anonymous-reviewer";
      try {
        const result = await bulkKeepRevisits({
          taskId,
          fieldId: field_id,
          patientIds: Array.isArray(patient_ids) ? patient_ids : undefined,
          reviewerId,
        });
        res.json({ ok: true, ...result });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    },
  );

  router.patch("/api/pilots/:taskId/:iterId", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "updating a pilot requires methodologist privilege" });
    }
    const { state, notes } = req.body ?? {};
    const allowedStates: PilotState[] = [
      "running", "ready_to_validate", "complete", "abandoned",
      "validating", "revising", "superseded", "locked",
    ];
    if (state && !allowedStates.includes(state)) {
      return res.status(400).json({ error: `state must be one of ${allowedStates.join(", ")}` });
    }
    try {
      const updated = setPilotState(
        req.params.taskId,
        req.params.iterId,
        (state ?? "running") as PilotState,
        notes,
      );
      // #42 — when a pilot is marked complete, fire the self-critique in the
      // background. The reviewer no longer has to remember to click the
      // critique button. fireAutoCritique no-ops if a critique already exists
      // or if one is currently running.
      if (state === "complete") {
        fireAutoCritique(req.params.taskId, req.params.iterId, reviewerId);
      }
      res.json(updated);
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // TODO(regression-gate-endpoint): Wire GET /api/pilots/:taskId/regression-check
  // Deferred pending a clean single-patient-all-criteria rerun export from batch-run infra.
  // Domain logic in regression-gate.ts is ready; needs adapter to call reRunPatient callback.

  router.get("/api/pilots/:taskId/stop-rule", (req, res) => {
    try {
      const report = evaluateStopRule({ taskId: req.params.taskId });
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── /api/versions/... aliases ─────────────────────────────────────────────
  // New code should use /api/versions/...; /api/pilots/... continues to work.

  router.get("/api/versions/:taskId", (req, res) => {
    res.json(listPilotIterations(req.params.taskId));
  });

  router.get("/api/versions/:taskId/:vTag", (req, res) => {
    const { taskId, vTag } = req.params as { taskId: string; vTag: string };
    const m = getPilotManifest(taskId, vTag);
    if (!m) return res.status(404).json({ error: "iter not found" });
    const critique = getPilotCritique(taskId, vTag);
    res.json({ manifest: m, critique });
  });

  router.get("/api/versions/:taskId/:vTag/revisits", (req, res) => {
    const { taskId, vTag } = req.params;
    const result = computeRevisitsForIter({ taskId, iterId: vTag });
    res.json({ ok: true, ...result });
  });

  // GET /api/versions/:taskId/:vTag/cells — VersionCellMatrix
  router.get("/api/versions/:taskId/:vTag/cells", (req, res) => {
    const { taskId, vTag } = req.params as { taskId: string; vTag: string };
    const manifest = getPilotManifest(taskId, vTag);
    if (!manifest) return res.status(404).json({ error: `iter not found: ${vTag}` });

    try {
      const cohort = readCohortSampling(taskId);
      const patientIds: string[] = (manifest as any).patient_sample
        ?? cohort?.dev_patient_ids
        ?? [];
      const criteriaHashes = manifest.criterion_schema_hashes ?? {};
      const fieldIds = Object.keys(criteriaHashes);

      const { rows: revisitRows } = computeRevisitsForIter({ taskId, iterId: vTag });
      const staleKey = (pid: string, fid: string) => `${pid}__${fid}`;
      const staleSet = new Set(revisitRows.map((r) => staleKey(r.patient_id, r.field_id)));

      const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT
        ?? path.resolve(process.cwd(), "..");
      const reviewsRootDir = process.env.CHART_REVIEW_REVIEWS_ROOT
        ?? path.join(platformRoot, "reviews");

      const cells: Array<{
        patient_id: string;
        field_id: string;
        state: "fresh" | "stale" | "unvalidated";
        reviewer_answer?: unknown;
        captured_against_schema_hash?: string;
      }> = [];

      for (const patientId of patientIds) {
        let reviewerAssessments: Record<string, {
          answer?: unknown;
          captured_against_schema_hash?: string;
        }> = {};
        try {
          const rsPath = path.join(reviewsRootDir, patientId, taskId, "review_state.json");
          if (fs.existsSync(rsPath)) {
            const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
              field_assessments?: Array<{
                field_id: string;
                source: string;
                answer?: unknown;
                captured_against_schema_hash?: string;
              }>;
            };
            for (const fa of rs.field_assessments ?? []) {
              if (fa.source === "reviewer") {
                reviewerAssessments[fa.field_id] = {
                  answer: fa.answer,
                  captured_against_schema_hash: fa.captured_against_schema_hash,
                };
              }
            }
          }
        } catch { /* best-effort */ }

        for (const fieldId of fieldIds) {
          const isStale = staleSet.has(staleKey(patientId, fieldId));
          const reviewerRec = reviewerAssessments[fieldId];
          const currentHash = criteriaHashes[fieldId];

          let cellState: "fresh" | "stale" | "unvalidated";
          if (isStale) {
            cellState = "stale";
          } else if (reviewerRec && reviewerRec.captured_against_schema_hash === currentHash) {
            cellState = "fresh";
          } else {
            cellState = "unvalidated";
          }

          cells.push({
            patient_id: patientId,
            field_id: fieldId,
            state: cellState,
            reviewer_answer: reviewerRec?.answer,
            captured_against_schema_hash: reviewerRec?.captured_against_schema_hash,
          });
        }
      }

      res.json({ cells, total: cells.length, iter_id: vTag });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // POST /api/versions/:taskId/:vTag/revise — create next pilot iter with criterion edits applied.
  router.post(
    "/api/versions/:taskId/:vTag/revise",
    express.json(),
    (req, res) => {
      const reviewerId = reviewerIdOf(req);
      if (!isMethodologist(reviewerId)) {
        return res.status(403).json({ error: "revise requires methodologist privilege" });
      }
      const { taskId, vTag } = req.params as { taskId: string; vTag: string };
      const { criteria_edits, patient_sample_change } = req.body ?? {};

      if (!Array.isArray(criteria_edits)) {
        return res.status(422).json({ error: "criteria_edits (array) required" });
      }

      const source = getPilotManifest(taskId, vTag);
      if (!source) return res.status(404).json({ error: `iter not found: ${vTag}` });

      try {
        const skillCriteriaDir = path.join(
          phenotypeSkillDir(taskId), "references", "criteria",
        );
        for (const edit of criteria_edits as Array<{ field_id: string; new_yaml: string }>) {
          if (!edit.field_id || typeof edit.new_yaml !== "string") continue;
          const filePath = path.join(skillCriteriaDir, `${edit.field_id}.md`);
          fs.mkdirSync(skillCriteriaDir, { recursive: true });
          fs.writeFileSync(filePath, edit.new_yaml);
        }

        const updatedSource = transitionIterToRevising(taskId, vTag);

        const cohort = readCohortSampling(taskId);
        let patientIds: string[] = (source as any).patient_sample ?? cohort?.dev_patient_ids ?? [];
        if (patient_sample_change) {
          const remove = new Set<string>(patient_sample_change.remove ?? []);
          patientIds = patientIds.filter((p) => !remove.has(p));
          patientIds = Array.from(new Set([...patientIds, ...(patient_sample_change.add ?? [])]));
        }

        const startResult = startPilotIteration({
          task_id: taskId,
          patient_ids: patientIds,
          started_by: reviewerId,
          onRunStatus: opts.onRunStatus,
        });
        const newManifest = startResult.pilot;

        const oldHashes = (source as any).criterion_schema_hashes ?? {};
        const newHashes = (newManifest as any).criterion_schema_hashes ?? {};
        const staleCells: Array<{ patient_id: string; field_id: string }> = [];
        for (const [fieldId, newHash] of Object.entries(newHashes)) {
          if (oldHashes[fieldId] !== newHash) {
            for (const pid of patientIds) {
              staleCells.push({ patient_id: pid, field_id: fieldId });
            }
          }
        }

        res.status(201).json({
          new_version_tag: newManifest.iter_id,
          stale_cells: staleCells,
          source_iter_state: updatedSource.state,
        });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );

  return router;
}
