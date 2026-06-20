// rubric-version-routes.ts — list + switch rubric versions (session inner loop +
// baseline outer loop). Promote is added in a sibling task. See the
// session-scoped-rubric-versioning design.
//
//   GET  /api/rubric/:taskId/sessions/:sessionId/versions  — the session's version timeline
//   POST /api/rubric/:taskId/sessions/:sessionId/switch    — set the active session version
//   GET  /api/rubric/:taskId/versions                      — the baseline (promoted) versions
import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import {
  readVersionLog,
  switchVersion,
  deleteVersion,
  diffVersions,
  snapshotVersion,
  getActiveVersion,
  draftDiffersFromActive,
  diffDraftAgainstActive,
  currentVsBase,
  discardDraftField,
} from "@chart-review/rubric-versions";
import { sessionRubricRoot, baselineRubricRoot } from "@chart-review/rubric";
import { getSessionManifest } from "./lib/domain/iter/index.js";
import { readRefinementLog } from "./lib/refine/provenance.js";

/** Recursively copy a directory tree (used to promote a session version's
 *  references/ into the baseline working copy before snapshotting it). */
function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

export const rubricVersionRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/versions",
    handler: async (_b, _r, p) => {
      const root = sessionRubricRoot(p.taskId, p.sessionId);
      const log = readVersionLog(root);
      if (!log) throw httpErr(404, "no rubric versions for this session");
      return { active: log.active, versions: log.versions, dirty: draftDiffersFromActive(root) };
    },
  },
  {
    // Checkpoint the session's working draft as a new version. Body { note? } sets
    // the version's source label (default "manual checkpoint"). Content-SHA dedup:
    // an unchanged draft returns the active version with unchanged:true.
    method: "POST",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/versions",
    handler: async (body, _r, p) => {
      const root = sessionRubricRoot(p.taskId, p.sessionId);
      if (!fs.existsSync(path.join(root, "references"))) {
        throw httpErr(404, `no rubric fork for session ${p.sessionId}`);
      }
      const note = (body as { note?: unknown } | null)?.note;
      const source = typeof note === "string" && note.trim() ? note.trim() : "manual checkpoint";
      const before = getActiveVersion(root);
      const version = snapshotVersion(root, {
        prefix: "s",
        source,
        by: "reviewer",
        now: new Date().toISOString(),
      });
      return { version, unchanged: version.id === before };
    },
  },
  {
    // The working draft's per-file line diff vs the active version — UNSAVED
    // changes only (drives dirty flag + per-change undo).
    method: "GET",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/draft-diff",
    handler: async (_b, _r, p) => {
      const root = sessionRubricRoot(p.taskId, p.sessionId);
      return { changes: diffDraftAgainstActive(root) };
    },
  },
  {
    // Transparent "what does the active version look like" view: for every field
    // this session has refined (from the log) — plus anything else changed vs the
    // fork base — return the field's FULL current text with additions-vs-base
    // marked, and a `dirty` flag (unsaved vs the active version). A field refined
    // in a later version still shows its full text here at an earlier active
    // version (just without the green), so switching versions is never blank.
    method: "GET",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/rubric-view",
    handler: async (_b, _r, p) => {
      const root = sessionRubricRoot(p.taskId, p.sessionId);
      const refined = Array.from(
        new Set(
          readRefinementLog(p.taskId, undefined, p.sessionId)
            .filter((e) => !e.reverted)
            .map((e) => `criteria/${e.field_id}.md`),
        ),
      );
      const dirty = new Set(diffDraftAgainstActive(root).map((c) => c.file));
      const changes = currentVsBase(root, refined).map((c) => ({ ...c, dirty: dirty.has(c.file) }));
      return { changes };
    },
  },
  {
    // Undo one field's uncommitted edits — restore it from the active version.
    method: "POST",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/draft/discard",
    handler: async (body, _r, p) => {
      const file = (body as { file?: unknown } | null)?.file;
      if (typeof file !== "string" || !file.trim()) throw httpErr(400, "file is required");
      try {
        discardDraftField(sessionRubricRoot(p.taskId, p.sessionId), file);
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/switch",
    handler: async (body, _r, p) => {
      const v = (body as { version?: unknown } | null)?.version;
      if (typeof v !== "string" || !v.trim()) throw httpErr(400, "version is required");
      try {
        switchVersion(sessionRubricRoot(p.taskId, p.sessionId), v);
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
      return { ok: true, active: v };
    },
  },
  {
    // Delete a session rubric version (e.g. an author-edit you no longer want).
    // The base version (s1, the fork root) cannot be deleted; deleting the active
    // version re-materializes its parent first.
    method: "DELETE",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/versions/:versionId",
    handler: async (_b, _r, p) => {
      const root = sessionRubricRoot(p.taskId, p.sessionId);
      try {
        deleteVersion(root, p.versionId);
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
      const log = readVersionLog(root);
      return { ok: true, active: log?.active ?? null, versions: log?.versions ?? [] };
    },
  },
  {
    // Diff two versions of a session's rubric (for the switch/promote confirm UI).
    method: "GET",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/diff",
    handler: async (_b, _r, p, query) => {
      const a = query.get("from");
      const b = query.get("to");
      if (!a || !b) throw httpErr(400, "from and to version ids are required");
      return { from: a, to: b, files: diffVersions(sessionRubricRoot(p.taskId, p.sessionId), a, b) };
    },
  },
  {
    method: "GET",
    pattern: "/api/rubric/:taskId/versions",
    handler: async (_b, _r, p) => {
      const log = readVersionLog(baselineRubricRoot(p.taskId));
      return { active: log?.active ?? null, versions: log?.versions ?? [] };
    },
  },
  {
    // Promote a chosen session rubric version to a NEW baseline version. The
    // reviewed-diff confirm lives in the UI; the server enforces the base-drift
    // guard (refuse if the baseline advanced since this session forked, unless
    // confirm_drift) and appends an immutable baseline version.
    method: "POST",
    pattern: "/api/rubric/:taskId/promote",
    handler: async (body, _r, p) => {
      const b = (body ?? {}) as { session_id?: string; session_version?: string; confirm_drift?: boolean };
      if (!b.session_id) throw httpErr(400, "session_id is required");
      const fork = sessionRubricRoot(p.taskId, b.session_id);
      const log = readVersionLog(fork);
      if (!log || !log.active) throw httpErr(404, "session has no rubric fork");
      const version = b.session_version ?? log.active;
      if (!log.versions.some((v) => v.id === version)) {
        throw httpErr(404, `session version ${version} not found`);
      }

      // Base-drift guard: did the baseline advance since this session forked?
      const manifest = getSessionManifest(p.taskId, b.session_id) as
        | { rubric?: { based_on?: string } }
        | null;
      const baseActive = getActiveVersion(baselineRubricRoot(p.taskId));
      const basedOn = manifest?.rubric?.based_on;
      if (basedOn && baseActive && basedOn !== baseActive && !b.confirm_drift) {
        throw httpErr(
          409,
          `baseline advanced ${basedOn}→${baseActive} since this session forked; ` +
            `promoting will create a new version from your content and may drop those changes. ` +
            `Re-POST with confirm_drift:true to proceed.`,
        );
      }

      // Materialize the chosen session version into the baseline working copy,
      // then snapshot it as a new baseline version.
      const base = baselineRubricRoot(p.taskId);
      fs.rmSync(path.join(base, "references"), { recursive: true, force: true });
      copyTree(path.join(fork, "versions", version, "references"), path.join(base, "references"));
      const v = snapshotVersion(base, {
        prefix: "v",
        source: `promote:${b.session_id}/${version}`,
        by: "reviewer",
        now: new Date().toISOString(),
      });
      // snapshotVersion dedups by content-SHA: if the chosen session version is
      // byte-identical to the current baseline, no new version is created and it
      // returns the existing active one — i.e. there was nothing to promote.
      const unchanged = v.id === baseActive;
      return { ok: true, baseline_version: v.id, unchanged, from: { session_id: b.session_id, version } };
    },
  },
];
