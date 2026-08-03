// POST /api/ner-sdk/annotate {session_id} — ensure the review batch exists and
// the vendored workbench (:18090) is running, then return the embed URL for the
// reviewer view (opened in an iframe by the VALIDATE tab). Reviewer role only.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { getSessionManifest } from "@chart-review/domain-iter";

const DEFAULT_TASK_ID = "bso-ad-ner-sdk";
const WORKBENCH_PORT = 18090;
const REVIEWER = "reviewer_1";
const VENDOR = path.join(PLATFORM_ROOT, "vendor", "bso-ad-sdk");
const REVIEW_ROOT = path.join(PLATFORM_ROOT, "var", "annotate", "review");

function httpErr(s: number, m: string): Error & { status: number } { const e = new Error(m) as Error & { status: number }; e.status = s; return e; }
function safeId(v: unknown): string { if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) throw httpErr(400, "invalid id"); return v; }
function csvField(s: string): string { return `"${s.replace(/"/g, '""')}"`; }
// Batch id/dir are namespaced by task AND session: two NER tasks share session
// ids, so a session-only key made one task's review batch surface under the
// other (bso-ad-ner showing bso-ad-ner-sdk's mentions).
function batchIdFor(taskId: string, sessionId: string): string { return `${taskId}__${sessionId}`; }
function batchDir(taskId: string, sessionId: string): string { return path.join(REVIEW_ROOT, "batches", batchIdFor(taskId, sessionId)); }
function legacyBatchDir(sessionId: string): string { return path.join(REVIEW_ROOT, "batches", sessionId); }
function vendorEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try { for (const raw of fs.readFileSync(path.join(VENDOR, ".env"), "utf-8").split("\n")) {
    const l = raw.trim(); if (!l || l.startsWith("#")) continue; const eq = l.indexOf("="); if (eq < 0) continue;
    let val = l.slice(eq + 1).trim(); if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[l.slice(0, eq).trim()] = val;
  } } catch { /* optional */ }
  return out;
}
// The workbench + batch_init need the vendored SDK's deps (fastapi/uvicorn/…),
// which are installed in vendor/bso-ad-sdk/.venv — NOT in the system python3
// (crashes with ModuleNotFoundError: uvicorn). Prefer the venv interpreter.
function vendorPython(): string {
  const venv = path.join(VENDOR, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
}
function checkTcp(host: string, port: number, ms = 1200): Promise<boolean> {
  return new Promise((res) => { const s = net.connect({ host, port }); const d = (ok: boolean) => { s.destroy(); res(ok); };
    s.setTimeout(ms); s.on("connect", () => d(true)); s.on("timeout", () => d(false)); s.on("error", () => d(false)); });
}
function ensureBatch(taskId: string, sessionId: string): string {
  const batchId = batchIdFor(taskId, sessionId);
  const dir = batchDir(taskId, sessionId);
  if (fs.existsSync(path.join(dir, "manifest.json"))) return batchId;
  // A dir without a manifest is a partial/failed batch_init — clear it so a retry
  // (or the migration below) starts clean instead of hitting the vendored
  // "batch directory exists" error forever.
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  // One-time migration: legacy batches (created when this route hardcoded
  // bso-ad-ner-sdk) live at batches/<session> with no task in the key and belong
  // to bso-ad-ner-sdk. Adopt them into the namespaced path so their reviewer
  // verdicts aren't orphaned. Other tasks never owned a legacy batch.
  const legacy = legacyBatchDir(sessionId);
  if (taskId === DEFAULT_TASK_ID && fs.existsSync(path.join(legacy, "manifest.json"))) {
    fs.renameSync(legacy, dir);
    return batchId;
  }
  const session = getSessionManifest(taskId, sessionId);
  if (!session) throw httpErr(404, `session ${sessionId} not found for task ${taskId}`);
  const patientIds = session.cohort?.patient_ids ?? [];
  if (!patientIds.length) throw httpErr(400, `session ${sessionId} has an empty cohort`);
  fs.mkdirSync(path.join(PLATFORM_ROOT, "var", "annotate"), { recursive: true });
  const notesCsv = path.join(PLATFORM_ROOT, "var", "annotate", `${batchId}-notes.csv`);
  const rows = ["note_id,person_id,note_text"]; const noteIds: string[] = [];
  for (const pid of patientIds) {
    const personId = pid.replace(/^patient_real_/, "");
    const nd = path.join(PLATFORM_ROOT, "corpus", "patients", pid, "notes");
    if (!fs.existsSync(nd)) continue;
    for (const f of fs.readdirSync(nd).filter((x) => x.endsWith(".txt"))) {
      const noteId = f.replace(/\.txt$/, "");
      rows.push([csvField(noteId), csvField(personId), csvField(fs.readFileSync(path.join(nd, f), "utf-8"))].join(","));
      noteIds.push(noteId);
    }
  }
  if (noteIds.length === 0) {
    throw httpErr(400, `no notes to annotate for session ${sessionId} — its cohort (${patientIds.join(", ")}) has no notes materialized here`);
  }
  fs.writeFileSync(notesCsv, rows.join("\n") + "\n");
  const r = spawnSync(vendorPython(), ["pipeline/batch_init.py",
    "--results-root", path.join(PLATFORM_ROOT, "var", "benchmark-sdk", taskId, sessionId),
    "--review-root", REVIEW_ROOT, "--batch-id", batchId,
    "--reviewers", "reviewer_1", "reviewer_2", "--notes-csv", notesCsv,
    "--include-note-id", ...noteIds,
  ], { cwd: VENDOR, env: { ...process.env, ...vendorEnv() }, encoding: "utf-8" });
  if (r.status !== 0 && !fs.existsSync(path.join(dir, "manifest.json"))) throw httpErr(500, `batch_init failed: ${(r.stderr || r.stdout || "").slice(-800)}`);
  return batchId;
}

export const nerSdkAnnotateRoutes: RouteEntry[] = [
  {
    method: "POST",
    pattern: "/api/ner-sdk/annotate",
    handler: async (body) => {
      const b = (body ?? {}) as { session_id?: unknown; task_id?: unknown };
      const sessionId = safeId(b.session_id);
      const taskId = b.task_id == null ? DEFAULT_TASK_ID : safeId(b.task_id);
      const batchId = ensureBatch(taskId, sessionId);
      if (!(await checkTcp("127.0.0.1", WORKBENCH_PORT))) {
        const annotateDir = path.join(PLATFORM_ROOT, "var", "annotate");
        fs.mkdirSync(annotateDir, { recursive: true });
        const logFd = fs.openSync(path.join(annotateDir, "workbench.log"), "a");
        const child = spawn(vendorPython(), ["pipeline/workbench.py", "--review-root", REVIEW_ROOT, "--ontology-root", path.join(VENDOR, "ontology")],
          { cwd: VENDOR, env: { ...process.env, ...vendorEnv() }, detached: true, stdio: ["ignore", logFd, logFd] });
        child.unref();
        await new Promise((r) => setTimeout(r, 1800));
      }
      const url = `http://127.0.0.1:${WORKBENCH_PORT}/?embed=1&reviewer=${REVIEWER}&batch=${encodeURIComponent(batchId)}`;
      return { url, batch_id: batchId };
    },
  },
];
