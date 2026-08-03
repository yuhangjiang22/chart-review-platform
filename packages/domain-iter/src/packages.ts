/**
 * Packages — named, immutable snapshots of a task's rubric state.
 *
 * A package captures the skill's `references/` subtree at a moment in
 * time (typically at the end of a successful session), plus metadata
 * about which session produced it and what calibration scores it
 * achieved. Future sessions can "start from package X" to inherit
 * the refined rubric as their starting point.
 *
 * Why packages (vs just relying on git history):
 *   - A method needs to be programmatically callable from the UI
 *     without dropping the methodologist into git plumbing.
 *   - Calibration scores live alongside the rubric snapshot, so a
 *     user picking a package can see "this rubric got F1=0.78" and
 *     pick based on evidence.
 *   - The session that produced the package is recorded as the
 *     audit trail.
 *
 * Layout on disk:
 *   .agents/skills/<task-id>/packages/<package-id>/
 *     ├── manifest.json
 *     └── skill_snapshot/
 *         └── references/
 *             ├── entity_type_guidance/
 *             ├── questions/
 *             ├── rules/
 *             ├── concepts.json
 *             └── ...
 *
 * Note: this MVP snapshots only `references/`. SKILL.md and meta.yaml
 * are intentionally NOT snapshotted — they're considered stable shell
 * configuration that doesn't drift across the improvement loop.
 */
import fs from "fs";
import path from "path";
import { guidelineDir } from "@chart-review/rubric";
import { computeTaskSha } from "@chart-review/lock";
import type { AgentSpec } from "@chart-review/agent-specs";

export interface PackageManifest {
  package_id: string;
  name: string;
  description?: string;
  generated_at: string;
  generated_by: string;
  task_id: string;
  source_session_id: string | null;
  skill_snapshot_sha: string;
  /** Snapshot of the source session's agent_specs at the time the
   *  package was generated. Lets "start from package" pre-fill the
   *  new session's agent config with what worked. */
  agent_specs?: AgentSpec[];
  /** Calibration summary if available — gives the methodologist
   *  evidence to pick this package over another. Free-form JSON
   *  blob; today this is what NerCalibrationFigure / AdherenceIaa
   *  return for the source session at the moment of generation. */
  calibration_summary?: Record<string, unknown> | null;
}

export interface CreatePackageInput {
  task_id: string;
  name: string;
  description?: string;
  generated_by: string;
  source_session_id: string | null;
  agent_specs?: AgentSpec[];
  calibration_summary?: Record<string, unknown> | null;
}

export function packagesDir(taskId: string): string {
  return path.join(guidelineDir(taskId), "packages");
}

function packageDir(taskId: string, packageId: string): string {
  return path.join(packagesDir(taskId), packageId);
}

function packageManifestPath(taskId: string, packageId: string): string {
  return path.join(packageDir(taskId, packageId), "manifest.json");
}

function isValidPackageId(s: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(s);
}

/** Normalize a user-provided name to a filesystem-safe package_id. */
export function slugifyPackageId(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "package";
}

// ── read helpers ─────────────────────────────────────────────────────────

export function getPackageManifest(
  taskId: string,
  packageId: string,
): PackageManifest | null {
  if (!isValidPackageId(packageId)) return null;
  const p = packageManifestPath(taskId, packageId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as PackageManifest;
  } catch {
    return null;
  }
}

export function listPackages(taskId: string): PackageManifest[] {
  const dir = packagesDir(taskId);
  if (!fs.existsSync(dir)) return [];
  const out: PackageManifest[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!isValidPackageId(name)) continue;
    const m = getPackageManifest(taskId, name);
    if (m) out.push(m);
  }
  // Newest first.
  return out.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
}

// ── write helpers ────────────────────────────────────────────────────────

function ensureUniquePackageId(taskId: string, baseId: string): string {
  const dir = packagesDir(taskId);
  if (!fs.existsSync(dir)) return baseId;
  if (!fs.existsSync(path.join(dir, baseId))) return baseId;
  // Collision — append -2, -3, ... until unused.
  for (let n = 2; n < 1000; n++) {
    const candidate = `${baseId}-${n}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw new Error(`could not find unique package_id starting from ${baseId}`);
}

function copyDirRecursive(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
    // skip symlinks etc.
  }
}

export function createPackage(input: CreatePackageInput): PackageManifest {
  if (!input.name || input.name.trim().length === 0) {
    throw new Error("package name is required");
  }
  const baseId = slugifyPackageId(input.name);
  const packageId = ensureUniquePackageId(input.task_id, baseId);
  const pkgDir = packageDir(input.task_id, packageId);
  fs.mkdirSync(pkgDir, { recursive: true });

  // Snapshot the live skill's references/ subtree into skill_snapshot/.
  const sourceReferences = path.join(guidelineDir(input.task_id), "references");
  const targetReferences = path.join(pkgDir, "skill_snapshot", "references");
  if (fs.existsSync(sourceReferences)) {
    copyDirRecursive(sourceReferences, targetReferences);
  } else {
    fs.mkdirSync(targetReferences, { recursive: true });
  }

  const manifest: PackageManifest = {
    package_id: packageId,
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    generated_at: new Date().toISOString(),
    generated_by: input.generated_by,
    task_id: input.task_id,
    source_session_id: input.source_session_id,
    skill_snapshot_sha: computeTaskSha(guidelineDir(input.task_id)),
    agent_specs: input.agent_specs,
    calibration_summary: input.calibration_summary ?? null,
  };

  const manifestPath = packageManifestPath(input.task_id, packageId);
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, manifestPath);
  return manifest;
}

export function deletePackage(taskId: string, packageId: string): boolean {
  if (!isValidPackageId(packageId)) return false;
  const dir = packageDir(taskId, packageId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Apply a package's skill_snapshot to the live task's references/.
 * REPLACES the current references/ entirely — this is destructive.
 * Callers should warn the user; today, the UI gates this behind a
 * confirmation dialog AND ensures no active session is mid-iter
 * (cohort drift would result).
 */
export function applyPackage(taskId: string, packageId: string): PackageManifest {
  const m = getPackageManifest(taskId, packageId);
  if (!m) throw new Error(`package not found: ${packageId}`);
  const snapshotReferences = path.join(
    packageDir(taskId, packageId), "skill_snapshot", "references",
  );
  if (!fs.existsSync(snapshotReferences)) {
    throw new Error(`package ${packageId} has no skill_snapshot/references`);
  }
  const liveReferences = path.join(guidelineDir(taskId), "references");
  // Atomic-ish: stage to a sibling, then swap.
  const staging = `${liveReferences}.staging.${process.pid}`;
  copyDirRecursive(snapshotReferences, staging);
  // Move old aside as a backup, swap staging in, drop the backup.
  const backup = `${liveReferences}.backup.${Date.now()}`;
  if (fs.existsSync(liveReferences)) {
    fs.renameSync(liveReferences, backup);
  }
  try {
    fs.renameSync(staging, liveReferences);
  } catch (e) {
    // Roll back.
    if (fs.existsSync(backup)) fs.renameSync(backup, liveReferences);
    throw e;
  }
  if (fs.existsSync(backup)) {
    fs.rmSync(backup, { recursive: true, force: true });
  }
  return m;
}
