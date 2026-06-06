// Task-package export (light platform).
//
// POST /api/export/:taskId?session_id=<sid> — write a self-contained package
// to var/exports/<taskId>/<export_id>/ capturing everything needed to re-run
// this validated task on a larger cohort:
//   task.json         rubric (per-field prompt/enum/definition/guidance),
//                     overview, the fixed run prompt, and the agent config
//   performance.json  this session's per-agent agent-vs-human accuracy
//   gold/<pid>.json   the validated gold-standard review_state per patient
//   manifest.json     provenance (when, session, snapshot, counts)
//
// Saved server-side (no download) so it can be picked up to deploy on more
// patients.

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { loadCompiledTask } from "@chart-review/tasks";
import { listPilotIterations, getSessionManifest } from "./lib/domain/iter/index.js";
import { computePerformance } from "./performance-routes.js";

const RUN_PROMPT_SUMMARY =
  "Notes-only agent run (deepagents): read all notes (list_notes/read_notes), " +
  "read the rubric criteria (list_criteria/read_criteria), then commit one " +
  "set_field_assessment per field. Cite the smallest verbatim supporting span " +
  "(use find_quote_offsets); never the whole note; for no_info cite the section " +
  "checked. This run prompt is fixed (code-level), not part of the editable rubric.";

function fieldId(f: { field_id?: string; id?: string }): string {
  return f.field_id ?? (f as { id: string }).id;
}

function writeJson(p: string, obj: unknown): void {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

export const exportRoutes: RouteEntry[] = [
  {
    method: "POST",
    pattern: "/api/export/:taskId",
    handler: async (_b, _r, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) {
        const err = new Error(`task ${p.taskId} not found`) as Error & { status: number };
        err.status = 404;
        throw err;
      }
      const sessionId = query.get("session_id");
      const session = sessionId ? getSessionManifest(p.taskId, sessionId) : null;

      // Rubric (the editable "skill") — prompt + allowed answers + guidance.
      const fields = (task.fields as unknown as Array<Record<string, unknown>>).map((f) => ({
        field_id: fieldId(f),
        prompt: f.prompt ?? null,
        answer_enum: (f.answer_schema as { enum?: unknown[] } | undefined)?.enum ?? null,
        definition: (f.guidance_prose as { definition?: string } | undefined)?.definition ?? null,
        extraction_guidance: f.extraction_guidance ?? null,
      }));
      const primaryCriterionIds = fields.map((f) => f.field_id);

      // Performance, scoped to this session's runs.
      let sessionRunIds: Set<string> | null = null;
      if (sessionId) {
        sessionRunIds = new Set(
          listPilotIterations(p.taskId)
            .filter((i) => i.session_id === sessionId && i.state !== "abandoned")
            .map((i) => i.run_id)
            .filter(Boolean),
        );
      }
      const performance = computePerformance(p.taskId, primaryCriterionIds, sessionRunIds);

      // Gold answers: validated review_states for the session's cohort.
      const cohort: string[] = (session?.cohort as { patient_ids?: string[] } | undefined)?.patient_ids ?? [];
      const reviewsDir = path.join(PLATFORM_ROOT, "var", "reviews");
      const gold: Record<string, unknown> = {};
      for (const pid of cohort) {
        const rsPath = path.join(reviewsDir, pid, p.taskId, "review_state.json");
        if (!fs.existsSync(rsPath)) continue;
        try {
          const state = JSON.parse(fs.readFileSync(rsPath, "utf8")) as { review_status?: string };
          if (state.review_status === "reviewer_validated") gold[pid] = state;
        } catch { /* skip unreadable */ }
      }

      const exportedAt = new Date().toISOString();
      const exportId = `${sessionId ?? "all"}-${exportedAt.replace(/[:.]/g, "-")}`;
      const dir = path.join(PLATFORM_ROOT, "var", "exports", p.taskId, exportId);
      fs.mkdirSync(path.join(dir, "gold"), { recursive: true });

      writeJson(path.join(dir, "task.json"), {
        task_id: p.taskId,
        overview_prose: (task as { overview_prose?: string }).overview_prose ?? null,
        run_prompt_summary: RUN_PROMPT_SUMMARY,
        fields,
        agent_config: (session?.agent_specs as unknown) ?? null,
      });
      writeJson(path.join(dir, "performance.json"), { session_id: sessionId, ...performance, exported_at: exportedAt });
      for (const [pid, state] of Object.entries(gold)) {
        writeJson(path.join(dir, "gold", `${pid}.json`), state);
      }
      const goldPids = Object.keys(gold);
      writeJson(path.join(dir, "manifest.json"), {
        exported_at: exportedAt,
        task_id: p.taskId,
        session_id: sessionId,
        session_name: (session as { name?: string } | null)?.name ?? null,
        skill_snapshot_sha: (session as { skill_snapshot_sha?: string } | null)?.skill_snapshot_sha ?? null,
        n_gold_patients: goldPids.length,
        gold_patient_ids: goldPids,
        files: ["task.json", "performance.json", "manifest.json", ...goldPids.map((pid) => `gold/${pid}.json`)],
      });

      return {
        ok: true,
        export_id: exportId,
        dir: path.relative(PLATFORM_ROOT, dir),
        n_gold_patients: goldPids.length,
      };
    },
  },
];
