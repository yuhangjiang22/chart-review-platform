/**
 * Sessions — a fixed-cohort grouping of pilot iters.
 *
 * Layered ABOVE the existing iter model. A session owns:
 *   - A locked cohort (patient_ids fixed at session start)
 *   - Default agent_specs (carried into each new iter unless overridden)
 *   - A skill_snapshot_sha for the skill state at session start
 *   - State machine: active | archived
 *
 * Iters belong to a session via their manifest.session_id field. Existing
 * iters without session_id are virtually grouped under the synthetic
 * "session_legacy" id — there's no on-disk legacy manifest, just a
 * read-time projection.
 *
 * Layout on disk:
 *   .agents/skills/<task-id>/sessions/
 *     ├── session_001/
 *     │   └── manifest.json
 *     ├── session_002/
 *     │   └── manifest.json
 *     └── ...
 *
 * Why a sibling dir to pilots/ instead of nesting iters under sessions/?
 *   - Existing iters live at .../pilots/iter_NNN/ — moving them breaks
 *     run-id resolution, audit trails, and downstream readers.
 *   - Iters reference their session by session_id field; that's a cheaper
 *     model than restructuring directories.
 */
import fs from "fs";
import path from "path";
import { guidelineDir } from "@chart-review/rubric";
import { computeTaskSha } from "@chart-review/lock";
import type { AgentSpec } from "@chart-review/agent-specs";

export type SessionState = "active" | "archived";

/** Synthetic id for iters with no session_id field on their manifest. */
export const LEGACY_SESSION_ID = "session_legacy";

export interface SessionManifest {
  session_id: string; // "session_001" (or LEGACY_SESSION_ID for virtual)
  session_num: number; // 1, 2, ... (0 for legacy)
  task_id: string;
  name: string;
  notes?: string;
  started_at: string;
  started_by: string;
  state: SessionState;
  ended_at?: string;
  cohort: { patient_ids: string[] };
  /** Default agent_specs for iters started under this session. Iters may
   *  override per-spec but inherit this as their starting point. */
  default_agent_specs?: AgentSpec[];
  /** Git SHA (or content hash) of the skill at session start. Lets you
   *  see how the skill drifted across the session's lifetime. */
  skill_snapshot_sha: string;
}

export interface SessionListing extends SessionManifest {
  iter_count: number;
  iter_ids: string[];
}

// ── on-disk layout ───────────────────────────────────────────────────────

export function sessionsDir(taskId: string): string {
  return path.join(guidelineDir(taskId), "sessions");
}

function sessionDir(taskId: string, sessionId: string): string {
  return path.join(sessionsDir(taskId), sessionId);
}

function sessionManifestPath(taskId: string, sessionId: string): string {
  return path.join(sessionDir(taskId, sessionId), "manifest.json");
}

function isValidSessionId(s: string): boolean {
  return s === LEGACY_SESSION_ID || /^session_\d{3,}$/.test(s);
}

// ── read helpers ─────────────────────────────────────────────────────────

export function getSessionManifest(
  taskId: string,
  sessionId: string,
): SessionManifest | null {
  if (!isValidSessionId(sessionId)) return null;
  const p = sessionManifestPath(taskId, sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as SessionManifest;
  } catch {
    return null;
  }
}

/** List all on-disk session manifests, newest first. */
export function listSessions(taskId: string): SessionManifest[] {
  const dir = sessionsDir(taskId);
  if (!fs.existsSync(dir)) return [];
  const out: SessionManifest[] = [];
  for (const name of fs.readdirSync(dir).sort().reverse()) {
    if (!/^session_\d+$/.test(name)) continue;
    const m = getSessionManifest(taskId, name);
    if (m) out.push(m);
  }
  return out;
}

// ── write helpers ────────────────────────────────────────────────────────

function nextSessionId(taskId: string): { session_id: string; session_num: number } {
  const dir = sessionsDir(taskId);
  let maxNum = 0;
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^session_(\d+)$/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1]!, 10));
    }
  }
  const num = maxNum + 1;
  return { session_id: `session_${String(num).padStart(3, "0")}`, session_num: num };
}

function writeManifestAtomic(taskId: string, m: SessionManifest): void {
  const dir = sessionDir(taskId, m.session_id);
  fs.mkdirSync(dir, { recursive: true });
  const fp = sessionManifestPath(taskId, m.session_id);
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, fp);
}

export interface CreateSessionInput {
  task_id: string;
  name: string;
  started_by: string;
  patient_ids: string[];
  notes?: string;
  default_agent_specs?: AgentSpec[];
}

export function createSession(input: CreateSessionInput): SessionManifest {
  if (!input.name || input.name.trim().length === 0) {
    throw new Error("session name is required");
  }
  if (!input.patient_ids || input.patient_ids.length === 0) {
    throw new Error("cohort patient_ids must be non-empty");
  }
  const { session_id, session_num } = nextSessionId(input.task_id);
  const manifest: SessionManifest = {
    session_id,
    session_num,
    task_id: input.task_id,
    name: input.name.trim(),
    notes: input.notes?.trim() || undefined,
    started_at: new Date().toISOString(),
    started_by: input.started_by,
    state: "active",
    cohort: { patient_ids: [...input.patient_ids] },
    default_agent_specs: input.default_agent_specs,
    skill_snapshot_sha: computeTaskSha(guidelineDir(input.task_id)),
  };
  writeManifestAtomic(input.task_id, manifest);
  return manifest;
}

export function archiveSession(
  taskId: string,
  sessionId: string,
): SessionManifest | null {
  const m = getSessionManifest(taskId, sessionId);
  if (!m) return null;
  if (m.state === "archived") return m;
  const updated: SessionManifest = {
    ...m,
    state: "archived",
    ended_at: new Date().toISOString(),
  };
  writeManifestAtomic(taskId, updated);
  return updated;
}

/** Return the session_id stamped on an iter manifest, or LEGACY_SESSION_ID
 *  when absent. Helper to unify legacy and modern iters at query time. */
export function iterSessionId(iterManifest: { session_id?: string }): string {
  return iterManifest.session_id ?? LEGACY_SESSION_ID;
}

/** Synthetic "virtual" listing for legacy iters that predate the session
 *  model. Returned by listSessionsWithCounts so the UI can show legacy
 *  iters under a stable, browsable header even though there's no real
 *  manifest on disk for them. */
export function legacySessionPlaceholder(taskId: string): SessionManifest {
  return {
    session_id: LEGACY_SESSION_ID,
    session_num: 0,
    task_id: taskId,
    name: "Legacy iters (pre-session)",
    started_at: "1970-01-01T00:00:00.000Z",
    started_by: "system",
    state: "archived",
    cohort: { patient_ids: [] },
    skill_snapshot_sha: "",
  };
}
