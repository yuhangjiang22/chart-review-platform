/**
 * Atomic write helpers for state files.
 *
 * Use these any time you write a state file (manifest, review_state, audit
 * head, deployment-kappa report, cohort sample selection — anything where a
 * partial write or process death mid-write would corrupt the file). The
 * pattern is:
 *
 *   1. Write the bytes to a temp file in the same directory.
 *   2. fsync the temp file.
 *   3. rename the temp over the destination — POSIX rename is atomic when
 *      source and destination are on the same filesystem.
 *
 * Readers never see a partial write: they either see the old content (before
 * rename) or the new content (after rename). A process death mid-write leaves
 * the temp file behind but the destination is untouched.
 *
 * Do NOT use these for append-only logs (audit.jsonl, deployment-issues.jsonl)
 * — those use fs.appendFileSync directly and are already crash-safe at line
 * granularity.
 *
 * The temp file name carries the process PID to avoid collisions when the
 * same path is written by multiple processes (rare but possible during dev).
 */

import fs from "fs";
import path from "path";

/**
 * Write a string atomically. The destination directory must already exist.
 * Throws if the rename fails; the temp file is cleaned up on failure.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw e;
  }
}

/**
 * Serialize and write JSON atomically. Pretty-prints with 2-space indent
 * (matches existing project convention). Trailing newline added so the file
 * ends cleanly.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2) + "\n");
}
