import { createHash } from "crypto";
import fs from "fs";
import path from "path";

export interface LockReadinessResult {
  ready: boolean;
  reason?: string;
}

/**
 * Compute a 16-char hex SHA-256 of a compiled task.
 *
 * Accepts either:
 * - A single file (legacy compiled JSON): hashes the file content.
 * - A SKILL bundle directory: walks files in lexicographic order, hashes
 *   each file's relative path + content. Skips `versions/` and `_*` subdirs
 *   so version archives and ephemeral subdirs don't affect the SHA.
 */
export function computeTaskSha(bundlePathOrFile: string): string {
  const stat = fs.statSync(bundlePathOrFile);
  const hasher = createHash("sha256");

  if (stat.isFile()) {
    hasher.update(fs.readFileSync(bundlePathOrFile));
  } else {
    function walk(dir: string, rel = ""): string[] {
      const out: string[] = [];
      for (const name of fs.readdirSync(dir).sort()) {
        // Skip ephemeral subdirs at any depth
        if (name === "versions" || name.startsWith("_")) continue;
        const full = path.join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        const s = fs.statSync(full);
        if (s.isDirectory()) out.push(...walk(full, r));
        else out.push(r);
      }
      return out;
    }
    const files = walk(bundlePathOrFile);
    for (const r of files) {
      hasher.update(r + "\n");
      hasher.update(fs.readFileSync(path.join(bundlePathOrFile, r)));
      hasher.update("\n");
    }
  }
  return hasher.digest("hex").slice(0, 16);
}

/**
 * Check whether a review is in the right state to be locked.
 * Lock requires review_status === "reviewer_validated".
 */
export function lockReadyCheck(reviewStatus: string | undefined): LockReadinessResult {
  if (reviewStatus !== "reviewer_validated") {
    return {
      ready: false,
      reason: `review_status is "${reviewStatus ?? "unset"}"; lock requires "reviewer_validated"`,
    };
  }
  return { ready: true };
}
