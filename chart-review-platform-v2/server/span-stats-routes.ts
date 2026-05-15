// Span stats aggregator (Phase 4.4).
//
// GET /api/pilots/:taskId/:iterId/span-stats
//   → {
//       patients: [{ patient_id, total, mapped, novel, rejected, validated }, ...],
//       totals:    { total, mapped, novel, rejected, validated },
//       n_patients: <int>,
//     }
//
// Walks each patient's reviews/<pid>/<task>/review_state.json and tallies
// spans by status. NER analogue of the cell-count derivation Workspace
// does for phenotype tasks. Called by Workspace.tsx when task_kind="ner"
// to drive the DECIDE / LOCK / VALIDATE progress UIs.
//
// "validated" is note-level — set by the reviewer via the
// `POST /api/reviews/:patientId/:taskId/notes/:noteId/validation` toggle
// and persisted in review_state.validated_notes. `total` is the number
// of distinct notes that carry at least one span for that patient (the
// notes that appear in the SpanReview UI). The mapped/novel/rejected
// counters are span-level breakdowns kept for the per-patient
// drill-down, not for the validation gate.

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { pathFor } from "@chart-review/storage";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

interface SpanStat {
  patient_id: string;
  total: number;
  mapped: number;
  novel: number;
  rejected: number;
  validated: number;
}

import { getPilotManifest } from "./lib/domain/iter/index.js";
import { getRunStatus } from "./lib/infra/batch-run/index.js";

export const spanStatsRoutes: RouteEntry[] = [
  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId/span-stats",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      if (task.task_kind !== "ner") {
        throw httpErr(400, `task ${p.taskId} is not an NER task (task_kind=${task.task_kind})`);
      }
      const manifest = getPilotManifest(p.taskId, p.iterId);
      if (!manifest) throw httpErr(404, `pilot ${p.iterId} not found`);
      // Patient ids: prefer the run status (live), fall back to the
      // manifest. Same fallback pattern the pilot route uses.
      const status = getRunStatus(manifest.run_id);
      const patientIds = status?.per_patient
        ? Object.keys(status.per_patient)
        : [];
      const patients: SpanStat[] = [];
      const totals: SpanStat = {
        patient_id: "(total)", total: 0, mapped: 0, novel: 0,
        rejected: 0, validated: 0,
      };
      for (const patientId of patientIds) {
        const fp = pathFor.reviewState(patientId, p.taskId);
        const stat: SpanStat = {
          patient_id: patientId, total: 0, mapped: 0, novel: 0,
          rejected: 0, validated: 0,
        };
        let notesWithSpans = new Set<string>();
        let validatedNotesWithSpans = 0;
        if (fs.existsSync(fp)) {
          try {
            const review = JSON.parse(fs.readFileSync(fp, "utf8")) as {
              span_labels?: Array<{ status?: string; note_id?: string }>;
              validated_notes?: string[];
            };
            for (const s of review.span_labels ?? []) {
              const st = s.status ?? "mapped";
              if (st === "mapped") stat.mapped++;
              else if (st === "rejected") stat.rejected++;
              else if (st === "novel_candidate") stat.novel++;
              if (s.note_id) notesWithSpans.add(s.note_id.replace(/\.txt$/, ""));
            }
            const validatedSet = new Set(review.validated_notes ?? []);
            for (const n of notesWithSpans) {
              if (validatedSet.has(n)) validatedNotesWithSpans++;
            }
          } catch { /* skip malformed */ }
        }
        // Note-level validation: total = notes that carry at least one
        // span, validated = subset that the reviewer has marked done.
        stat.total = notesWithSpans.size;
        stat.validated = validatedNotesWithSpans;
        patients.push(stat);
        totals.total += stat.total;
        totals.mapped += stat.mapped;
        totals.novel += stat.novel;
        totals.rejected += stat.rejected;
        totals.validated += stat.validated;
      }
      // path is unused here; suppress unused-import for the typechecker.
      void path;
      return {
        ok: true,
        task_id: p.taskId,
        iter_id: p.iterId,
        n_patients: patients.length,
        patients,
        totals: {
          total: totals.total,
          mapped: totals.mapped,
          novel: totals.novel,
          rejected: totals.rejected,
          validated: totals.validated,
        },
      };
    },
  },
];
