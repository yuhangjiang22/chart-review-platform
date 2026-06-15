import fs from "fs";
import path from "path";
import { guidelineDir } from "@chart-review/rubric";

export interface CohortSampling {
  task_id: string;
  version: number;
  created_at: string;
  created_by: string;
  dev_patient_ids: string[];
  lock_patient_ids: string[];
  stratification_notes?: string;
}

function samplingPath(taskId: string): string {
  return path.join(guidelineDir(taskId), "sampling.json");
}

export function readCohortSampling(taskId: string): CohortSampling | null {
  const p = samplingPath(taskId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as CohortSampling;
}

export function writeCohortSampling(taskId: string, cohort: CohortSampling): void {
  if (cohort.task_id !== taskId) {
    throw new Error(`cohort.task_id (${cohort.task_id}) does not match taskId (${taskId})`);
  }
  const dev = new Set(cohort.dev_patient_ids);
  const overlap = cohort.lock_patient_ids.filter((id) => dev.has(id));
  if (overlap.length > 0) {
    throw new Error(`DEV and LOCK cohorts overlap on: ${overlap.join(", ")}`);
  }
  const p = samplingPath(taskId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cohort, null, 2));
}

export function defaultCohortSizes(): { dev: number; lock: number } {
  return { dev: 10, lock: 30 };
}

import type { Express, Request, Response } from "express";

export function registerCohortSamplingRoutes(app: Express): void {
  app.get("/api/cohort-sampling/:taskId", (req: Request, res: Response) => {
    const cohort = readCohortSampling(req.params.taskId);
    if (!cohort) return res.status(404).json({ error: "no_cohort_yet" });
    return res.json(cohort);
  });

  app.put("/api/cohort-sampling/:taskId", (req: Request, res: Response) => {
    try {
      writeCohortSampling(req.params.taskId, req.body);
      return res.status(204).end();
    } catch (e) {
      return res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });
}
