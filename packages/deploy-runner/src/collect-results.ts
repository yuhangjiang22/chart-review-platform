// packages/deploy-runner/src/collect-results.ts
import fs from "node:fs";
import path from "node:path";
import { agentDraftPath, type RunStatus } from "@chart-review/infra-batch-run";

export interface CollectMeta {
  package_dir: string; task_id: string; agent_reason: string;
  model: string | null; env_model: string | null;
  model_mismatch_warning: string | null; data_dir: string;
}
export interface CollectArgs {
  runId: string; status: RunStatus; agentId: string;
  fieldIds: string[]; outDir: string; meta: CollectMeta;
}
export interface CollectResult { n_ok: number; n_failed: number; failed_patient_ids: string[]; }

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function collectResults(args: CollectArgs): CollectResult {
  const { runId, status, agentId, fieldIds, outDir, meta } = args;
  fs.mkdirSync(outDir, { recursive: true });

  const ok: string[] = [];
  const failed: string[] = [];
  const csvRows: string[] = [["patient_id", ...fieldIds].map(csvCell).join(",")];

  for (const [pid, ps] of Object.entries(status.per_patient)) {
    if (ps.state !== "complete") { failed.push(pid); continue; }
    let draft: { field_assessments?: Array<{ field_id: string; answer?: unknown }> };
    try { draft = JSON.parse(fs.readFileSync(agentDraftPath(runId, pid, agentId), "utf8")); }
    catch { failed.push(pid); continue; }
    const fas = draft.field_assessments ?? [];
    // per-patient json
    fs.writeFileSync(
      path.join(outDir, `${pid}.json`),
      JSON.stringify({ patient_id: pid, task_id: meta.task_id, agent_id: agentId, field_assessments: fas }, null, 2) + "\n",
    );
    // csv row
    const byField = new Map(fas.map((f) => [f.field_id, f.answer]));
    csvRows.push([pid, ...fieldIds.map((f) => byField.get(f))].map(csvCell).join(","));
    ok.push(pid);
  }

  ok.sort();
  failed.sort();
  fs.writeFileSync(path.join(outDir, "results.csv"), csvRows.join("\n") + "\n");
  fs.writeFileSync(
    path.join(outDir, "run_manifest.json"),
    JSON.stringify({
      ...meta, agent_id: agentId, run_id: runId,
      n_patients: ok.length + failed.length, n_ok: ok.length, n_failed: failed.length,
      ok_patient_ids: ok, failed_patient_ids: failed,
    }, null, 2) + "\n",
  );
  return { n_ok: ok.length, n_failed: failed.length, failed_patient_ids: failed };
}
