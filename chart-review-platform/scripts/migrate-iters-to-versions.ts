#!/usr/bin/env node
/**
 * migrate-iters-to-versions.ts
 *
 * One-shot, idempotent migration script.
 * Copies each skillDir/pilots/iter_NNN/ to skillDir/versions/vN/,
 * rewrites the manifest, and leaves a relative symlink at the old path.
 *
 * Usage:
 *   npx tsx scripts/migrate-iters-to-versions.ts [--dry-run]
 */

import * as fs from "fs";
import * as path from "path";

export interface MigrationEntry {
  taskId: string;
  iter_id: string;
  iter_num: number;
  source_dir: string;
  target_dir: string;
  symlink_path: string;
  already_migrated: boolean;
}

/**
 * Walk every guideline skill's pilots/ directory and return one
 * MigrationEntry per iter_NNN subdirectory found.
 *
 * When rootOverride is provided, scans directly from the filesystem:
 *   rootOverride/.claude/skills/chart-review-{id}/pilots/iter_NNN/
 *
 * This avoids the need for meta.yaml + SKILL.md (which listCompiledTasks
 * requires) so tests can inject minimal tmp filesystem layouts.
 *
 * When rootOverride is omitted, delegates to listCompiledTasks() +
 * guidelineDir() from the server domain layer.
 *
 * @param rootOverride  If provided, the function scans this directory tree
 *                      directly rather than calling listCompiledTasks().
 */
export function enumerateMigrations(rootOverride?: string): MigrationEntry[] {
  if (rootOverride !== undefined) {
    return enumerateFromRoot(rootOverride);
  }

  // Production path: use the compiled task registry.
  // Dynamic requires so the script can be loaded in test environments without
  // pulling in the full server module graph.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { listCompiledTasks } = require("../app/server/tasks.js") as typeof import("../app/server/tasks.js");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { guidelineDir } = require("../app/server/domain/rubric/index.js") as typeof import("../app/server/domain/rubric/index.js");

  const tasks = listCompiledTasks();
  const results: MigrationEntry[] = [];

  for (const task of tasks) {
    const gDir = guidelineDir(task.task_id);
    results.push(...collectPilotEntries(task.task_id, gDir));
  }

  return results;
}

/**
 * Direct filesystem scan — used when rootOverride is provided.
 * Walks root/.claude/skills/chart-review-{id}/pilots/ without requiring
 * meta.yaml or SKILL.md to exist.
 */
function enumerateFromRoot(root: string): MigrationEntry[] {
  const skillsRoot = path.join(root, ".claude", "skills");
  if (!fs.existsSync(skillsRoot)) return [];

  let skillDirNames: string[];
  try {
    skillDirNames = fs.readdirSync(skillsRoot);
  } catch {
    return [];
  }

  const results: MigrationEntry[] = [];

  for (const name of skillDirNames) {
    if (!name.startsWith("chart-review-")) continue;

    const skillDir = path.join(skillsRoot, name);
    const stat = fs.statSync(skillDir, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) continue;

    // Strip "chart-review-" prefix to recover taskId
    const taskId = name.slice("chart-review-".length);
    results.push(...collectPilotEntries(taskId, skillDir));
  }

  return results;
}

/**
 * Collect MigrationEntry items for all iter_NNN subdirs under
 * gDir/pilots/.
 */
function collectPilotEntries(taskId: string, gDir: string): MigrationEntry[] {
  const pilotsDir = path.join(gDir, "pilots");
  if (!fs.existsSync(pilotsDir)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(pilotsDir);
  } catch {
    return [];
  }

  const results: MigrationEntry[] = [];

  for (const name of entries) {
    const match = /^iter_(\d+)$/.exec(name);
    if (!match) continue;

    const iterNum = parseInt(match[1], 10);
    const iterId = name;
    const sourceDir = path.join(pilotsDir, iterId);
    const targetDir = path.join(gDir, "versions", `v${iterNum}`);
    const symlinkPath = sourceDir;

    const sourceIsSymlink =
      fs.existsSync(sourceDir) && fs.lstatSync(sourceDir).isSymbolicLink();
    const targetExists = fs.existsSync(targetDir);
    const alreadyMigrated = targetExists || sourceIsSymlink;

    results.push({
      taskId,
      iter_id: iterId,
      iter_num: iterNum,
      source_dir: sourceDir,
      target_dir: targetDir,
      symlink_path: symlinkPath,
      already_migrated: alreadyMigrated,
    });
  }

  return results;
}

export interface MigrationOptions {
  dryRun?: boolean;
  rootOverride?: string;
}

export async function runMigration(opts: MigrationOptions = {}): Promise<void> {
  const entries = enumerateMigrations(opts.rootOverride);

  if (entries.length === 0) {
    console.log("[INFO] No iter directories found. Nothing to migrate.");
    return;
  }

  for (const entry of entries) {
    const { taskId, iter_id, iter_num, source_dir, target_dir, symlink_path } = entry;
    const versionTag = `v${iter_num}`;
    console.log(`[INFO] Processing ${taskId} ${iter_id} -> ${versionTag}`);

    if (entry.already_migrated) {
      console.log(`[INFO] Skipping ${taskId} ${iter_id} -- already migrated`);
      continue;
    }

    if (opts.dryRun) {
      console.log(`[DRY-RUN] Would copy ${source_dir} -> ${target_dir}`);
      console.log(`[DRY-RUN] Would rewrite manifest at ${target_dir}/manifest.json`);
      console.log(`[DRY-RUN] Would create symlink ${symlink_path} -> ../versions/${versionTag}`);
      continue;
    }

    // 1. Copy the iter dir to versions/vN
    fs.cpSync(source_dir, target_dir, { recursive: true });
    console.log(`[INFO] Copied ${source_dir} -> ${target_dir}`);

    // 2. Rewrite the manifest in the target dir
    const manifestPath = path.join(target_dir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const rewritten = rewriteManifest(raw, versionTag);
      fs.writeFileSync(manifestPath, JSON.stringify(rewritten, null, 2));
      console.log(`[INFO] Rewrote manifest at ${manifestPath}`);
    }

    // 3. Remove the original dir and replace with a relative symlink
    fs.rmSync(source_dir, { recursive: true });
    fs.symlinkSync(`../versions/${versionTag}`, symlink_path);
    console.log(`[INFO] Symlinked ${symlink_path} -> ../versions/${versionTag}`);

    console.log(`[INFO] Migrated ${taskId} ${iter_id} -> ${versionTag}`);
  }
}

// CLI entry point — compare decoded pathnames so paths with spaces match.
if (process.argv[1] && decodeURIComponent(new URL(import.meta.url).pathname) === process.argv[1]) {
  const dryRun = process.argv.includes("--dry-run");
  runMigration({ dryRun }).catch((err: unknown) => {
    console.error("[ERROR]", err);
    process.exit(1);
  });
}

/**
 * Rewrite a pilot iter manifest to add version_tag and legacy_iter_id.
 *
 * Pure function -- does not mutate input. Idempotent: running twice on the
 * same input produces an identical output.
 */
export function rewriteManifest(
  manifest: Record<string, unknown>,
  versionTag: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...manifest };
  out.version_tag = versionTag;
  if ("iter_id" in manifest && !("legacy_iter_id" in manifest)) {
    out.legacy_iter_id = manifest.iter_id;
  }
  return out;
}
