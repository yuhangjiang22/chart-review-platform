#!/usr/bin/env tsx
/**
 * migrate-drafts.ts
 *
 * Cluster 2 (P0) — drafts/live path consolidation.
 *
 * Migrates chart-review skill directories from the legacy
 * `.claude/skills/drafts/chart-review-<id>/` location to the canonical live
 * path `.claude/skills/chart-review-<id>/`.
 *
 * After migration, draft state is conveyed by `status: draft` in `meta.yaml`,
 * not by directory location.
 *
 * Collision policy (per design):
 *   - If the live path does NOT exist → move (rename) the draft there.
 *   - If the live path DOES exist and contents are identical → delete the
 *     draft copy (it's redundant); log that it was cleaned up.
 *   - If the live path DOES exist and contents differ → leave both in place,
 *     log the conflict, require manual resolution. Do NOT silently overwrite.
 *
 * Idempotent: re-running on an empty drafts/ directory is a no-op.
 *
 * Usage:
 *   npx tsx app/scripts/migrate-drafts.ts [--platform-root <path>]
 *   npm run migrate-drafts   (from chart-review-platform/app/)
 */

import fs from "fs/promises";
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePlatformRoot(): string {
  // Allow override via env (matches test conventions) or CLI arg.
  if (process.env.CHART_REVIEW_PLATFORM_ROOT) {
    return process.env.CHART_REVIEW_PLATFORM_ROOT;
  }
  // CLI: --platform-root <path>
  const idx = process.argv.indexOf("--platform-root");
  if (idx !== -1 && process.argv[idx + 1]) {
    return path.resolve(process.argv[idx + 1]);
  }
  // Default: two levels up from app/scripts/ → chart-review-platform/
  return path.resolve(__dirname, "../..");
}

// ---------------------------------------------------------------------------
// Directory hashing (for identity comparison)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash of a directory tree.
 * Hashes the relative path + content of every file, sorted for determinism.
 * Skips nothing — callers that want to ignore certain paths should filter
 * before calling.
 */
async function hashDir(dir: string): Promise<string> {
  const hash = createHash("sha256");

  async function walk(current: string, prefix: string): Promise<void> {
    let entries: string[];
    try {
      entries = (await fs.readdir(current)).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(current, name);
      const rel = path.join(prefix, name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        await walk(full, rel);
      } else {
        hash.update(`F:${rel}\n`);
        const buf = await fs.readFile(full).catch(() => Buffer.alloc(0));
        hash.update(buf);
      }
    }
  }

  await walk(dir, "");
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Copy directory recursively
// ---------------------------------------------------------------------------

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  for (const name of await fs.readdir(src)) {
    const sp = path.join(src, name);
    const dp = path.join(dst, name);
    const stat = await fs.stat(sp);
    if (stat.isDirectory()) {
      await copyDirRecursive(sp, dp);
    } else {
      await fs.copyFile(sp, dp);
    }
  }
}

// ---------------------------------------------------------------------------
// Main migration logic
// ---------------------------------------------------------------------------

export interface MigrationResult {
  moved: string[];
  identicalDeleted: string[];
  conflicts: string[];
  skipped: string[];
  draftsRootRemoved: boolean;
}

/**
 * Run the migration. Reads from `draftsRoot`, writes to `skillsRoot`.
 * Both paths are derived from `platformRoot` when not overridden.
 *
 * Exported for testing.
 */
export async function migrateDrafts(
  platformRoot: string,
): Promise<MigrationResult> {
  const skillsRoot = path.join(platformRoot, ".claude", "skills");
  const draftsRoot = path.join(skillsRoot, "drafts");

  const result: MigrationResult = {
    moved: [],
    identicalDeleted: [],
    conflicts: [],
    skipped: [],
    draftsRootRemoved: false,
  };

  // If drafts/ doesn't exist, nothing to do.
  if (!existsSync(draftsRoot)) {
    console.log(`[migrate-drafts] drafts/ not found at ${draftsRoot} — nothing to do.`);
    return result;
  }

  // List subdirectories of drafts/.
  let entries: string[];
  try {
    entries = readdirSync(draftsRoot)
      .filter((name) => {
        if (name.startsWith(".")) return false;
        const full = path.join(draftsRoot, name);
        return statSync(full).isDirectory();
      })
      .sort();
  } catch (e) {
    console.error(`[migrate-drafts] Cannot read drafts/ directory: ${(e as Error).message}`);
    return result;
  }

  if (entries.length === 0) {
    console.log(`[migrate-drafts] drafts/ is empty — nothing to migrate.`);
    // Remove the empty drafts/ directory.
    try {
      await fs.rmdir(draftsRoot);
      result.draftsRootRemoved = true;
      console.log(`[migrate-drafts] Removed empty drafts/ directory.`);
    } catch {
      // May fail if not empty (e.g. hidden files); leave it.
    }
    return result;
  }

  for (const name of entries) {
    if (!name.startsWith("chart-review-")) {
      console.log(`[migrate-drafts] Skipping non-chart-review directory: ${name}`);
      result.skipped.push(name);
      continue;
    }

    const draftPath = path.join(draftsRoot, name);
    const livePath = path.join(skillsRoot, name);

    if (!existsSync(livePath)) {
      // Live path does not exist → move (rename for git rename detection).
      console.log(`[migrate-drafts] Moving ${name} → ${livePath}`);
      try {
        await fs.rename(draftPath, livePath);
      } catch (err: any) {
        if (err?.code === "EXDEV") {
          // Cross-device move — fall back to copy + delete.
          await copyDirRecursive(draftPath, livePath);
          await fs.rm(draftPath, { recursive: true, force: true });
        } else {
          throw err;
        }
      }
      result.moved.push(name);
      console.log(`[migrate-drafts]   ✓ Moved (draft deleted).`);
    } else {
      // Live path exists → compare.
      const [draftHash, liveHash] = await Promise.all([
        hashDir(draftPath),
        hashDir(livePath),
      ]);

      if (draftHash === liveHash) {
        // Identical — delete the draft copy.
        console.log(`[migrate-drafts] ${name}: draft == live (identical). Deleting draft copy.`);
        await fs.rm(draftPath, { recursive: true, force: true });
        result.identicalDeleted.push(name);
        console.log(`[migrate-drafts]   ✓ Draft deleted (live copy retained).`);
      } else {
        // Conflict — leave both, log.
        console.warn(
          `[migrate-drafts] CONFLICT: ${name} exists at both drafts/ and live path with different contents.`,
        );
        console.warn(
          `[migrate-drafts]   draft: ${draftPath}`,
        );
        console.warn(
          `[migrate-drafts]   live:  ${livePath}`,
        );
        console.warn(
          `[migrate-drafts]   Action required: manually inspect and resolve. Neither copy was modified.`,
        );
        result.conflicts.push(name);
      }
    }
  }

  // After processing all drafts, try to remove the drafts/ directory if empty
  // (and no conflicts remain).
  if (result.conflicts.length === 0) {
    try {
      const remaining = readdirSync(draftsRoot);
      if (remaining.length === 0) {
        await fs.rmdir(draftsRoot);
        result.draftsRootRemoved = true;
        console.log(`[migrate-drafts] Removed empty drafts/ directory.`);
      }
    } catch {
      // Leave it — either not empty or permission denied.
    }
  } else {
    console.warn(
      `[migrate-drafts] Leaving drafts/ in place: ${result.conflicts.length} conflict(s) need manual resolution.`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(result: MigrationResult): void {
  console.log("\n[migrate-drafts] Summary:");
  console.log(`  Moved to live path:       ${result.moved.length}`);
  console.log(`  Identical (draft deleted): ${result.identicalDeleted.length}`);
  console.log(`  Conflicts (need manual):  ${result.conflicts.length}`);
  console.log(`  Skipped (non-chart-review): ${result.skipped.length}`);
  if (result.draftsRootRemoved) {
    console.log(`  drafts/ directory removed.`);
  }
  if (result.conflicts.length > 0) {
    console.log("\nConflicts requiring manual resolution:");
    for (const name of result.conflicts) {
      console.log(`  - ${name}`);
    }
    console.log(
      "\nFor each conflict: inspect both copies and decide which to keep,\n" +
      "then delete the draft copy and run migrate-drafts again.",
    );
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const platformRoot = resolvePlatformRoot();
  console.log(`[migrate-drafts] Platform root: ${platformRoot}`);

  migrateDrafts(platformRoot)
    .then((result) => {
      printSummary(result);
      if (result.conflicts.length > 0) {
        process.exitCode = 1; // Signal that manual work is needed.
      }
    })
    .catch((e) => {
      console.error("[migrate-drafts] Fatal:", (e as Error).message);
      process.exitCode = 2;
    });
}
