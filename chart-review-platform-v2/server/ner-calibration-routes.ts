// NER calibration: compute F1 per entity type between each agent's
// draft and the reviewer-validated ground truth.
//
// GET /api/calibrate-ner/:taskId
//   → {
//       ok, task_id,
//       n_patients,            n_validated_notes,
//       n_reviewer_spans,
//       agents: [
//         { agent_id, macro_f1, tuple_kappa, per_entity_type: [...] }
//       ]
//     }
//
// Only validated_notes count as ground truth — same gate the improve
// driver uses. Loops over every patient in the task's reviews/ dir;
// loads agent drafts from the latest run that has agent drafts for
// that patient; filters everything to validated_notes; calls
// computeSpanIaa(agent, reviewer) per agent.

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { pathFor } from "@chart-review/storage";
import { listRuns, runDir } from "@chart-review/infra-batch-run";
import { computeSpanIaa } from "@chart-review/eval-span-iaa";
import { PLATFORM_ROOT } from "@chart-review/patients";
import type { SpanLabel } from "@chart-review/platform-types";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT
    ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

function latestRunWithAgents(taskId: string, patientId: string): string | null {
  const runs = listRuns({ task_id: taskId })
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  for (const r of runs) {
    const dir = path.join(runDir(r.run_id), "per_patient", patientId, "agents");
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".json"))) {
      return r.run_id;
    }
  }
  return null;
}

function readSpans(p: string): SpanLabel[] {
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { span_labels?: SpanLabel[] };
    return j.span_labels ?? [];
  } catch { return []; }
}

export const nerCalibrationRoutes: RouteEntry[] = [
  {
    method: "GET", pattern: "/api/calibrate-ner/:taskId",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, "task not found");
      if (task.task_kind !== "ner") {
        throw httpErr(400, `task ${p.taskId} is not an NER task`);
      }

      // Enumerate patients with a review_state.json for this task.
      const rRoot = reviewsRoot();
      const patientIds: string[] = [];
      if (fs.existsSync(rRoot)) {
        for (const pid of fs.readdirSync(rRoot)) {
          if (!/^[a-zA-Z0-9_-]+$/.test(pid)) continue;
          const rsp = pathFor.reviewState(pid, p.taskId);
          if (fs.existsSync(rsp)) patientIds.push(pid);
        }
      }

      // Aggregate per-agent: concat spans across patients (within
      // validated_notes only) then compute one SpanIaaReport per agent
      // against the reviewer.
      const agentSpans = new Map<string, SpanLabel[]>();
      const reviewerSpans: SpanLabel[] = [];
      let totalValidatedNotes = 0;

      for (const pid of patientIds) {
        const rs = JSON.parse(fs.readFileSync(pathFor.reviewState(pid, p.taskId), "utf8")) as {
          span_labels?: SpanLabel[];
          validated_notes?: string[];
        };
        const validated = new Set(rs.validated_notes ?? []);
        if (validated.size === 0) continue;
        totalValidatedNotes += validated.size;

        const rsSpans = (rs.span_labels ?? []).filter((s) => validated.has(s.note_id));
        reviewerSpans.push(...rsSpans);

        const runIdOrNull = latestRunWithAgents(p.taskId, pid);
        if (!runIdOrNull) continue;
        const agentsDir = path.join(runDir(runIdOrNull), "per_patient", pid, "agents");
        for (const f of fs.readdirSync(agentsDir).sort()) {
          if (!f.endsWith(".json")) continue;
          const aid = f.replace(/\.json$/, "");
          const spans = readSpans(path.join(agentsDir, f))
            .filter((s) => validated.has(s.note_id));
          const cur = agentSpans.get(aid) ?? [];
          cur.push(...spans);
          agentSpans.set(aid, cur);
        }
      }

      const agents: Array<{
        agent_id: string;
        macro_f1: number | undefined;
        tuple_kappa: number | undefined;
        per_entity_type: Array<{
          entity_type: string; agree: number; soft_or_boundary: number;
          miss_only_a: number; miss_only_b: number;
          precision: number; recall: number; f1: number;
        }>;
        n_spans: number;
      }> = [];

      for (const [aid, spans] of [...agentSpans.entries()].sort()) {
        // computeSpanIaa(a, b) treats a as the predictions and b as
        // the gold — we pass agent spans first, reviewer spans second.
        const report = computeSpanIaa(spans, reviewerSpans);
        agents.push({
          agent_id: aid,
          macro_f1: report.macro_f1,
          tuple_kappa: report.tuple_kappa,
          per_entity_type: report.per_entity_type.map((m) => ({
            entity_type: m.entity_type,
            agree: m.agree,
            soft_or_boundary: m.soft_or_boundary,
            miss_only_a: m.miss_only_a,
            miss_only_b: m.miss_only_b,
            precision: m.precision,
            recall: m.recall,
            f1: m.f1,
          })),
          n_spans: spans.length,
        });
      }

      return {
        ok: true,
        task_id: p.taskId,
        n_patients: patientIds.length,
        n_validated_notes: totalValidatedNotes,
        n_reviewer_spans: reviewerSpans.length,
        agents,
      };
    },
  },
];
