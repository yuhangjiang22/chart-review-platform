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
import { sessionReviewsRoot } from "./lib/session-reviews.js";
import { transitionMaturity, getMaturity } from "./lib/maturity.js";
import type { SpanLabel } from "@chart-review/platform-types";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** Resolve the active session from the request query; 400 if absent.
 *  No review_state read may fall back to the flat path — every read is
 *  scoped to this session. */
function sessionIdOf(query: URLSearchParams): string {
  const sid = query.get("session_id");
  if (!sid) throw httpErr(400, "session_id query param is required");
  return sid;
}

function latestRunWithAgents(taskId: string, patientId: string): string | null {
  const runs = listRuns({ task_id: taskId })
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  for (const r of runs) {
    const dir = path.join(runDir(r.run_id), "per_patient", patientId, "agents");
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".json") && !f.endsWith(".error.json"))) {
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
    handler: async (_b, _r, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, "task not found");
      if (task.task_kind !== "ner") {
        throw httpErr(400, `task ${p.taskId} is not an NER task`);
      }
      const sid = sessionIdOf(query);

      // Enumerate patients with a review_state.json for this task,
      // scoped to the active session.
      const rRoot = sessionReviewsRoot(sid);
      const patientIds: string[] = [];
      if (fs.existsSync(rRoot)) {
        for (const pid of fs.readdirSync(rRoot)) {
          if (!/^[a-zA-Z0-9_-]+$/.test(pid)) continue;
          const rsp = pathFor.reviewState(sid, pid, p.taskId);
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
        const rs = JSON.parse(fs.readFileSync(pathFor.reviewState(sid, pid, p.taskId), "utf8")) as {
          span_labels?: SpanLabel[];
          validated_notes?: string[];
        };
        const validated = new Set(rs.validated_notes ?? []);
        if (validated.size === 0) continue;
        totalValidatedNotes += validated.size;

        // GOLD SET: the reviewer's KEPT spans inside validated notes — spans
        // the reviewer marked `rejected` are excluded, so an agent doesn't get
        // credit for re-proposing something the reviewer threw out. (v2 counted
        // rejected spans as gold, which inflates agreement; we tightened it.)
        const rsSpans = (rs.span_labels ?? []).filter(
          (s) => validated.has(s.note_id) && s.status !== "rejected",
        );
        reviewerSpans.push(...rsSpans);

        const runIdOrNull = latestRunWithAgents(p.taskId, pid);
        if (!runIdOrNull) continue;
        const agentsDir = path.join(runDir(runIdOrNull), "per_patient", pid, "agents");
        for (const f of fs.readdirSync(agentsDir).sort()) {
          // Skip loud-fail markers — a `.error.json` is not an agent draft.
          if (!f.endsWith(".json") || f.endsWith(".error.json")) continue;
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
        // We pass agent spans as A, reviewer (gold) as B. NOTE:
        // computeSpanIaa defines precision/recall with A as the REFERENCE
        // and B as the hypothesis (its `fp = miss_only_b`), which is the
        // opposite of what we want here — so report.precision/recall come
        // out swapped for "agent vs gold". We recompute from the raw counts
        // with the AGENT as the hypothesis: a span only the agent has
        // (miss_only_a) is a false positive; a gold span the agent missed
        // (miss_only_b) is a false negative. F1 is symmetric so macro_f1 and
        // tuple_kappa are unaffected. (miss_only_a = agent-only,
        // miss_only_b = reviewer-only — the UI labels these directly.)
        const report = computeSpanIaa(spans, reviewerSpans);
        agents.push({
          agent_id: aid,
          macro_f1: report.macro_f1,
          tuple_kappa: report.tuple_kappa,
          per_entity_type: report.per_entity_type.map((m) => {
            const fp = m.miss_only_a + m.soft_or_boundary; // agent proposed, not in gold
            const fn = m.miss_only_b + m.soft_or_boundary; // gold the agent missed
            const precision = m.agree + fp > 0 ? m.agree / (m.agree + fp) : 0;
            const recall = m.agree + fn > 0 ? m.agree / (m.agree + fn) : 0;
            const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
            return {
              entity_type: m.entity_type,
              agree: m.agree,
              soft_or_boundary: m.soft_or_boundary,
              miss_only_a: m.miss_only_a,
              miss_only_b: m.miss_only_b,
              precision, recall, f1,
            };
          }),
          n_spans: spans.length,
        });
      }

      // Auto-advance maturity piloted → calibrated once we've actually
      // computed an F1 (any number, against any agent). Idempotent;
      // failures swallowed.
      try {
        const cur = getMaturity(p.taskId);
        const anyF1 = agents.some((a) => typeof a.macro_f1 === "number");
        if (cur.state === "piloted" && anyF1) {
          transitionMaturity(p.taskId, "calibrated", "auto-advance:f1-computed");
        }
      } catch { /* best-effort */ }

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
