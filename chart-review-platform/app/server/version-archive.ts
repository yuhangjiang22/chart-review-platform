// app/server/version-archive.ts
import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { CompiledTask, CompiledTaskField, guidelineDir } from "./domain/rubric/index.js";

export interface VersionEntry {
  task_id: string;
  lock_task_sha: string;
  archived_at: string;
  record_count: number;
  task_version?: string;
}

function versionsDir(taskId: string): string {
  return path.join(guidelineDir(taskId), "versions");
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const sp = path.join(src, name);
    const dp = path.join(dst, name);
    const stat = fs.statSync(sp);
    if (stat.isDirectory()) {
      // Skip ephemeral subdirs (versions/ and any _* dirs) to avoid recursive archive
      if (name === "versions" || name.startsWith("_")) continue;
      copyDirRecursive(sp, dp);
    } else {
      fs.copyFileSync(sp, dp);
    }
  }
}

export function archiveVersion(taskId: string, lockTaskSha: string): void {
  const sourceBundleDir = guidelineDir(taskId);
  const target = path.join(versionsDir(taskId), lockTaskSha);
  if (fs.existsSync(target)) return; // idempotent
  if (!fs.existsSync(sourceBundleDir) || !fs.existsSync(path.join(sourceBundleDir, "meta.yaml"))) {
    return; // no bundle to snapshot
  }
  copyDirRecursive(sourceBundleDir, target);
}

export function listVersions(taskId: string, reviewsRoot: string): VersionEntry[] {
  const dir = versionsDir(taskId);
  if (!fs.existsSync(dir)) return [];
  const out: VersionEntry[] = [];

  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    let sha: string;
    let task_version: string | undefined;
    let archivedTime: Date;

    if (stat.isDirectory() && fs.existsSync(path.join(fullPath, "meta.yaml"))) {
      sha = entry;
      archivedTime = stat.mtime;
      try {
        const meta = parseYaml(fs.readFileSync(path.join(fullPath, "meta.yaml"), "utf8")) as { task_version?: string };
        task_version = meta?.task_version;
      } catch { /* malformed YAML — skip task_version */ }
    } else if (stat.isFile() && entry.endsWith(".json")) {
      sha = entry.replace(/\.json$/, "");
      archivedTime = stat.mtime;
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, "utf8")) as { task_version?: string };
        task_version = data.task_version;
      } catch { /* malformed JSON — skip task_version */ }
    } else {
      continue; // not a recognized archive entry
    }

    out.push({
      task_id: taskId,
      lock_task_sha: sha,
      archived_at: archivedTime.toISOString(),
      record_count: countRecordsForSha(taskId, sha, reviewsRoot),
      task_version,
    });
  }
  return out.sort((a, b) => (a.archived_at < b.archived_at ? 1 : -1));
}

export function loadVersionedSkillBundle(taskId: string, lockTaskSha: string): CompiledTask | null {
  const dirPath = path.join(versionsDir(taskId), lockTaskSha);
  const legacyPath = path.join(versionsDir(taskId), `${lockTaskSha}.json`);

  if (fs.existsSync(path.join(dirPath, "meta.yaml"))) {
    // New bundle format
    const metaText = fs.readFileSync(path.join(dirPath, "meta.yaml"), "utf8");
    const meta = (parseYaml(metaText) ?? {}) as Record<string, unknown>;
    const criteriaDir = path.join(dirPath, "criteria");
    const fields: CompiledTaskField[] = [];
    if (fs.existsSync(criteriaDir)) {
      for (const f of fs.readdirSync(criteriaDir).filter((x) => x.endsWith(".yaml")).sort()) {
        try {
          fields.push(parseYaml(fs.readFileSync(path.join(criteriaDir, f), "utf8")) as CompiledTaskField);
        } catch { /* malformed YAML — skip */ }
      }
    }
    return { task_id: taskId, ...meta, fields } as CompiledTask;
  }
  if (fs.existsSync(legacyPath)) {
    // Legacy JSON archive — pre-E.0 locks
    try { return JSON.parse(fs.readFileSync(legacyPath, "utf8")) as CompiledTask; }
    catch { return null; }
  }
  return null;
}

// Backwards-compatible alias for callers that still import the old name
export const loadVersionedTask = loadVersionedSkillBundle;

function countRecordsForSha(taskId: string, sha: string, reviewsRoot: string): number {
  if (!fs.existsSync(reviewsRoot)) return 0;
  let n = 0;
  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const rsPath = path.join(reviewsRoot, pid, taskId, "review_state.json");
    if (!fs.existsSync(rsPath)) continue;
    try {
      const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as { lock_task_sha?: string };
      if (rs.lock_task_sha === sha) n++;
    } catch { /* unreadable review_state.json — skip */ }
  }
  return n;
}
