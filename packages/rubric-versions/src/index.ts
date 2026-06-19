// rubric-versions — an append-only, immutable version store for a rubric tree.
//
// Rooted at any dir that holds `references/` (the working copy) + `versions/`
// (immutable snapshots + a log). The SAME module is used at two levels:
//   - baseline: <skill>/                (prefix "v" — promoted versions)
//   - session:  <skill>/sessions/<sid>/rubric/  (prefix "s" — the inner loop)
//
// Versions are immutable; a movable `active` pointer in versions.json says which
// one the working copy currently mirrors. snapshotVersion() is content-SHA
// deduped, so a no-op save doesn't churn the timeline.
import fs from "node:fs";
import path from "node:path";
import { computeTaskSha } from "@chart-review/lock";
import { atomicWriteJson } from "@chart-review/storage";

import { diffLines, type DiffLine } from "./line-diff.js";
export { diffLines };
export type { LineDiff, DiffLine, DiffTag } from "./line-diff.js";

export interface RubricVersion {
  id: string; // "v4" | "s2"
  sha: string; // content hash of the snapshot's references/
  parent: string | null; // the version active when this one was created
  source: string; // "fork:v1" | "refine:cancer_type" | "author-edit" | "promote:session_054/s3" | "seed:initial"
  created_at: string;
  created_by: string;
}
export interface VersionLog {
  active: string | null;
  versions: RubricVersion[];
}

function logPath(root: string): string { return path.join(root, "versions", "versions.json"); }
function refsDir(root: string): string { return path.join(root, "references"); }
function versionRefsDir(root: string, id: string): string {
  return path.join(root, "versions", id, "references");
}

export function readVersionLog(root: string): VersionLog | null {
  const p = logPath(root);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as VersionLog;
  } catch {
    return null;
  }
}

export function getActiveVersion(root: string): string | null {
  return readVersionLog(root)?.active ?? null;
}

/** True when the working copy (references/) has uncommitted edits relative to the
 *  active version's snapshot — i.e. the draft is "dirty". False when the draft
 *  matches the active version, or when there is no active version to compare to. */
export function draftDiffersFromActive(root: string): boolean {
  const log = readVersionLog(root);
  if (!log || !log.active) return false;
  const active = log.versions.find((v) => v.id === log.active);
  if (!active) return false;
  return contentSha(refsDir(root)) !== active.sha;
}

/** Content hash of a references/ tree. Reuses the platform's task-SHA hasher,
 *  which sorts paths, hashes path+content, and skips `versions/` + `_`-prefixed
 *  subdirs — so it is stable and won't fold snapshots into the hash. */
export function contentSha(refs: string): string {
  return computeTaskSha(refs);
}

function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmTree(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function nextId(log: VersionLog | null, prefix: string): string {
  const n = (log?.versions ?? []).filter((v) => v.id.startsWith(prefix)).length + 1;
  return `${prefix}${n}`;
}

export interface SnapshotOpts { prefix: "v" | "s"; source: string; by: string; now: string; }

/** Snapshot the current working copy (references/) as a new immutable version and
 *  set it active. Content-SHA dedup: if the working copy is byte-identical to the
 *  active version's snapshot, returns the active version unchanged (no new id). */
export function snapshotVersion(root: string, opts: SnapshotOpts): RubricVersion {
  const log: VersionLog = readVersionLog(root) ?? { active: null, versions: [] };
  const sha = contentSha(refsDir(root));
  const active = log.versions.find((v) => v.id === log.active);
  if (active && active.sha === sha) return active; // dedup — no churn
  const id = nextId(log, opts.prefix);
  copyTree(refsDir(root), versionRefsDir(root, id));
  const version: RubricVersion = {
    id, sha, parent: log.active, source: opts.source, created_at: opts.now, created_by: opts.by,
  };
  log.versions.push(version);
  log.active = id;
  atomicWriteJson(logPath(root), log);
  return version;
}

/** Re-materialize the working copy from a chosen version and move the active
 *  pointer to it. Non-destructive: the chosen version's snapshot is untouched,
 *  so you can switch back. A later edit snapshots a new version whose parent is
 *  the switched-to version (history can branch). */
export function switchVersion(root: string, id: string): void {
  const log = readVersionLog(root);
  if (!log || !log.versions.some((v) => v.id === id)) throw new Error(`no such version: ${id}`);
  rmTree(refsDir(root));
  copyTree(versionRefsDir(root, id), refsDir(root));
  log.active = id;
  atomicWriteJson(logPath(root), log);
}

/** Delete a version + its snapshot. Refuses the BASE version (the fork root,
 *  parent=null) — there must always be a base to switch back to. If the deleted
 *  version is active, re-materializes + activates its parent first. Children of
 *  the deleted version are re-parented to its parent so the chain stays linked. */
export function deleteVersion(root: string, id: string): void {
  const log = readVersionLog(root);
  if (!log) throw new Error("no version log");
  const target = log.versions.find((v) => v.id === id);
  if (!target) throw new Error(`no such version: ${id}`);
  if (target.parent === null) throw new Error(`cannot delete the base version ${id}`);

  // Deleting the active version: switch (re-materialize the working copy) to its
  // parent first, so the live rubric still reflects a real version.
  if (log.active === id) switchVersion(root, target.parent);

  const fresh = readVersionLog(root)!; // switchVersion may have rewritten the log
  for (const v of fresh.versions) if (v.parent === id) v.parent = target.parent;
  fresh.versions = fresh.versions.filter((v) => v.id !== id);
  if (fresh.active === id) fresh.active = target.parent;
  atomicWriteJson(logPath(root), fresh);
  rmTree(path.join(root, "versions", id));
}

export interface FileDiff { file: string; status: "changed" | "added" | "removed"; }

/** Which criteria files differ between two snapshots (relative paths under
 *  references/). Used by the promote / switch confirm UI. */
export function diffVersions(root: string, idA: string, idB: string): FileDiff[] {
  const list = (base: string): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (d: string, rel: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else out.set(r, fs.readFileSync(path.join(d, e.name), "utf8"));
      }
    };
    walk(base, "");
    return out;
  };
  const ma = list(versionRefsDir(root, idA));
  const mb = list(versionRefsDir(root, idB));
  const diffs: FileDiff[] = [];
  for (const [f, va] of ma) {
    if (!mb.has(f)) diffs.push({ file: f, status: "removed" });
    else if (mb.get(f) !== va) diffs.push({ file: f, status: "changed" });
  }
  for (const f of mb.keys()) if (!ma.has(f)) diffs.push({ file: f, status: "added" });
  return diffs.sort((x, y) => x.file.localeCompare(y.file));
}

export interface DraftFileDiff {
  /** relative path under references/, e.g. "criteria/a.md" */
  file: string;
  status: "changed" | "added" | "removed";
  added: number;
  removed: number;
  lines: DiffLine[];
}

/** Diff the working copy (references/) against the ACTIVE version's snapshot,
 *  per file, with line-level hunks. Empty array when clean. Drives the Working
 *  Draft panel. */
export function diffDraftAgainstActive(root: string): DraftFileDiff[] {
  const log = readVersionLog(root);
  if (!log || !log.active) return [];
  const readTree = (base: string): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (d: string, rel: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else out.set(r, fs.readFileSync(path.join(d, e.name), "utf8"));
      }
    };
    walk(base, "");
    return out;
  };
  const draft = readTree(refsDir(root));
  const active = readTree(versionRefsDir(root, log.active));
  const out: DraftFileDiff[] = [];
  for (const [f, dtext] of draft) {
    const atext = active.get(f);
    if (atext === undefined) {
      const ld = diffLines("", dtext);
      out.push({ file: f, status: "added", added: ld.added, removed: ld.removed, lines: ld.lines });
    } else if (atext !== dtext) {
      const ld = diffLines(atext, dtext);
      out.push({ file: f, status: "changed", added: ld.added, removed: ld.removed, lines: ld.lines });
    }
  }
  for (const [f, atext] of active) {
    if (!draft.has(f)) {
      const ld = diffLines(atext, "");
      out.push({ file: f, status: "removed", added: ld.added, removed: ld.removed, lines: ld.lines });
    }
  }
  return out.sort((x, y) => x.file.localeCompare(y.file));
}

/** Undo one field's uncommitted edits: restore the file from the active version's
 *  snapshot (or delete it if it was added in the draft). Throws if the file isn't
 *  actually changed vs the active version. The working copy stays otherwise intact. */
export function discardDraftField(root: string, relPath: string): void {
  const changed = diffDraftAgainstActive(root).find((d) => d.file === relPath);
  if (!changed) throw new Error(`no draft change for ${relPath}`);
  const log = readVersionLog(root)!;
  const src = path.join(versionRefsDir(root, log.active!), relPath);
  const dst = path.join(refsDir(root), relPath);
  if (changed.status === "added") {
    rmTree(dst); // a plain file; rmTree force-removes whether file or dir
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

export interface ForkOpts { source: string; by: string; now: string; }

/** Initialize a fresh rubric root by copying a source references/ tree into it
 *  and snapshotting s1. Used by createSession to fork the baseline. */
export function forkFrom(srcRefs: string, dstRoot: string, opts: ForkOpts): RubricVersion {
  rmTree(refsDir(dstRoot));
  copyTree(srcRefs, refsDir(dstRoot));
  return snapshotVersion(dstRoot, { prefix: "s", source: opts.source, by: opts.by, now: opts.now });
}
