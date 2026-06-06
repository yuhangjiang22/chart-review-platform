// Adherence stats aggregator — adherence analogue of span-stats-routes.
//
// GET /api/pilots/:taskId/:iterId/adherence-stats
//   → {
//       n_patients,
//       per_patient: [{ patient_id, total_questions, validated_questions, total_rules, validated_rules }, ...],
//       totals:      { total, validated, total_rules, validated_rules },
//     }
//
// "validated" = the reviewer's count of questions they've accepted /
// overridden (review_state.validated_questions). "total" = number of
// questions in the task's skill bundle (constant across patients).
// Workspace.tsx uses `totals` to drive the DECIDE counter the same way
// span-stats drives it for NER.

import fs from "node:fs";
import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { pathFor } from "@chart-review/storage";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
import { getPilotManifest } from "./lib/domain/iter/index.js";
import { getRunStatus } from "./lib/infra/batch-run/index.js";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

interface AdherenceStat {
  patient_id: string;
  total_questions: number;
  validated_questions: number;
  total_rules: number;
  validated_rules: number;
}

export const adherenceStatsRoutes: RouteEntry[] = [
  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId/adherence-stats",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      if (task.task_kind !== "adherence") {
        throw httpErr(
          400,
          `task ${p.taskId} is not an adherence task (task_kind=${task.task_kind ?? "phenotype"})`,
        );
      }
      const skill = loadAdherenceSkill(p.taskId);
      const totalQuestions = [...skill.questions_by_tier.values()].reduce(
        (s, qs) => s + qs.length,
        0,
      );
      const totalRules = skill.rules.length;

      const manifest = getPilotManifest(p.taskId, p.iterId);
      if (!manifest) throw httpErr(404, `pilot ${p.iterId} not found`);
      const status = getRunStatus(manifest.run_id);
      const patientIds = status?.per_patient
        ? Object.keys(status.per_patient)
        : [];

      const perPatient: AdherenceStat[] = [];
      const totals = { total: 0, validated: 0, total_rules: 0, validated_rules: 0 };

      for (const patientId of patientIds) {
        const fp = pathFor.reviewState(patientId, p.taskId);
        const stat: AdherenceStat = {
          patient_id: patientId,
          total_questions: totalQuestions,
          validated_questions: 0,
          total_rules: totalRules,
          validated_rules: 0,
        };
        if (fs.existsSync(fp)) {
          try {
            const review = JSON.parse(fs.readFileSync(fp, "utf8")) as {
              validated_questions?: string[];
              validated_rules?: string[];
            };
            stat.validated_questions = (review.validated_questions ?? []).length;
            stat.validated_rules = (review.validated_rules ?? []).length;
          } catch { /* skip malformed */ }
        }
        perPatient.push(stat);
        totals.total += stat.total_questions;
        totals.validated += stat.validated_questions;
        totals.total_rules += stat.total_rules;
        totals.validated_rules += stat.validated_rules;
      }

      return {
        ok: true,
        task_id: p.taskId,
        iter_id: p.iterId,
        n_patients: perPatient.length,
        per_patient: perPatient,
        totals,
      };
    },
  },
];
