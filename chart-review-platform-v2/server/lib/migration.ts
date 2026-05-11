// app/server/migration.ts
import fs from "fs";
import path from "path";
import { appendAuditEntry } from "./audit-trail.js";

export interface MigrationInput {
  taskId: string;
  fromSha: string;
  toSha: string;
  patientIds: string[];
  reviewsRoot: string;
  triggeredBy: string;
}

export interface MigrationResult {
  archived: string[];
  reopened: string[];
  errors: Array<{ patient_id: string; error: string }>;
}

export async function runMigration(input: MigrationInput): Promise<MigrationResult> {
  const { taskId, fromSha, toSha, patientIds, reviewsRoot, triggeredBy } = input;
  const archived: string[] = [];
  const reopened: string[] = [];
  const errors: Array<{ patient_id: string; error: string }> = [];

  for (const pid of patientIds) {
    const rsPath = path.join(reviewsRoot, pid, taskId, "review_state.json");
    if (!fs.existsSync(rsPath)) {
      errors.push({ patient_id: pid, error: "review_state not found" });
      continue;
    }
    let rs: Record<string, unknown>;
    try {
      rs = JSON.parse(fs.readFileSync(rsPath, "utf8"));
    } catch (e) {
      errors.push({ patient_id: pid, error: `parse error: ${e}` });
      continue;
    }

    if (rs.review_status !== "locked" || rs.lock_task_sha !== fromSha) {
      errors.push({ patient_id: pid, error: `record not locked under ${fromSha} (status=${rs.review_status}, sha=${rs.lock_task_sha})` });
      continue;
    }

    const archiveDir = path.join(reviewsRoot, pid, taskId, "_archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${fromSha}.json`);
    fs.writeFileSync(archivePath, JSON.stringify(rs, null, 2));

    const reopened_rs: Record<string, unknown> = {
      ...rs,
      review_status: "agent_complete",
      version: ((rs.version as number) ?? 0) + 1,
      updated_at: new Date().toISOString(),
      updated_by: triggeredBy,
    };
    delete reopened_rs.lock_task_sha;
    delete reopened_rs.locked_at;
    delete reopened_rs.locked_by;
    fs.writeFileSync(rsPath, JSON.stringify(reopened_rs, null, 2));

    const ts = new Date().toISOString();
    const sessionId = `migrate-${Date.now()}`;
    appendAuditEntry(
      { patientId: pid, taskId, sessionId },
      {
        ts, session_id: sessionId,
        step_type: "record_superseded",
        from_sha: fromSha,
        to_sha: toSha,
        archived_path: `_archive/${fromSha}.json`,
        triggered_by: triggeredBy,
      },
    );

    archived.push(pid);
    reopened.push(pid);
  }

  if (archived.length > 0) {
    const ts = new Date().toISOString();
    const sessionId = `migrate-${Date.now()}`;
    appendAuditEntry(
      { patientId: archived[0], taskId, sessionId },
      {
        ts, session_id: sessionId,
        step_type: "migration_run",
        from_sha: fromSha,
        to_sha: toSha,
        affected_count: archived.length,
        triggered_by: triggeredBy,
      },
    );
  }

  return { archived, reopened, errors };
}
