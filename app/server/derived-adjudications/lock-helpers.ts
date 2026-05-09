import fs from "fs";
import path from "path";
import { readAuditLines } from "../infra/batch-run/index.js";
import {
  getPilotManifest,
  pilotIterDir as computePilotIterDir,
  listPilotIterations,
} from "../domain/iter/pilots.js";
import { runDir as computeRunDir, getRunManifest } from "../infra/batch-run/index.js";
import { listCompiledTasks } from "../tasks.js";
import type { CompiledTask } from "../tasks.js";
import type { FieldAssessment } from "../domain/review/review-state.js";

export interface PilotContext {
  iter_id: string;
  run_id: string;
  pilotIterDir: string;
  runDir: string;
}

export function resolvePilotContext(taskId: string, iter_id: string): PilotContext | null {
  const manifest = getPilotManifest(taskId, iter_id);
  if (!manifest) return null;
  return {
    iter_id,
    run_id: manifest.run_id,
    pilotIterDir: computePilotIterDir(taskId, iter_id),
    runDir: computeRunDir(manifest.run_id),
  };
}

export async function loadAgentDraftAndAudit(
  ctx: PilotContext,
  agent_id: "agent_1" | "agent_2",
  patient_id: string,
): Promise<{ agent_id: string; assessmentsByField: Record<string, FieldAssessment>; auditText: string } | null> {
  const draftPath = path.join(ctx.runDir, "per_patient", patient_id, "agents", `${agent_id}.json`);
  if (!fs.existsSync(draftPath)) return null;
  const raw = JSON.parse(fs.readFileSync(draftPath, "utf8"));
  const assessmentsByField: Record<string, FieldAssessment> = {};
  for (const fa of raw.field_assessments ?? []) {
    if (fa?.field_id) assessmentsByField[fa.field_id] = fa;
  }
  const lines = readAuditLines(ctx.run_id, patient_id);
  const auditText = lines.join("\n");
  return { agent_id, assessmentsByField, auditText };
}

export function loadGuidelineTextByField(task: CompiledTask): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of task.fields ?? []) {
    out[f.id] = [f.prompt, (f as any).guidance_md ?? "", (f as any).rules_summary ?? ""].filter(Boolean).join("\n\n");
  }
  return out;
}

/**
 * Find the most-recent pilot iter for `taskId` whose run includes `patientId`.
 * Returns the iter_id string, or null if the patient isn't in any pilot of
 * that task. Used by the lock route + the client-friendly derived-adjudications
 * GET endpoint to resolve iter_id without requiring it on the wire.
 */
export function findActiveIterIdForPatient(
  taskId: string,
  patientId: string,
): string | null {
  const iters = listPilotIterations(taskId);
  // Most recent first — listPilotIterations returns newest at top per existing
  // semantics; double-check by sorting on iter_num desc to be safe.
  const sorted = [...iters].sort((a, b) => b.iter_num - a.iter_num);
  for (const iter of sorted) {
    const runManifest = getRunManifest(iter.run_id);
    if (!runManifest) continue;
    if (runManifest.patient_ids?.includes(patientId)) {
      return iter.iter_id;
    }
  }
  return null;
}

/**
 * Search all guideline skills' pilots directories for a matching iter_id.
 * If found, return the absolute path of the matching pilots/<iter_id>/ dir.
 * If none found, return null. If multiple match (unlikely), return the most
 * recently modified one.
 */
export function resolvePilotIterDirFromIterId(iter_id: string): string | null {
  let best: { dir: string; mtime: number } | null = null;
  for (const task of listCompiledTasks()) {
    const pilotIterPath = computePilotIterDir(task.task_id, iter_id);
    const manifestPath = path.join(pilotIterPath, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const stat = fs.statSync(manifestPath);
      const mtime = stat.mtimeMs;
      if (!best || mtime > best.mtime) {
        best = { dir: pilotIterPath, mtime };
      }
    }
  }
  return best ? best.dir : null;
}
