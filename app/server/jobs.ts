/**
 * Generic streaming-job primitive for long-running agent invocations
 * (authoring, methods drafting, cohort feedback, ...).
 *
 *   jobs/<job_id>/
 *     manifest.json     immutable input args + provenance
 *     status.json       mutable: state, cost, result, error
 *     transcript.jsonl  append-only stream of agent events
 *
 * Each driver translates its `query()` SDK stream into JobEvents (one
 * per assistant message / tool_use / tool_result / final result) and
 * appends them via `appendJobEvent`. Each append broadcasts an
 * `agent_job_update` over WS so the UI can render incrementally.
 *
 * job_id format: `<kind>-<ISO ts>-<8-char uuid>`. Lex sort = recency.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { atomicWriteJson } from "./storage.js";
import { PLATFORM_ROOT } from "./patients.js";

export type JobKind = "authoring" | "cohort_feedback" | "methods_drafting";
export type JobState = "running" | "complete" | "error";

export interface JobManifest {
  job_id: string;
  kind: JobKind;
  task_id?: string;
  started_at: string;
  started_by: string;
  payload?: Record<string, unknown>;
}

export interface JobStatus {
  job_id: string;
  state: JobState;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  error?: string;
  result?: unknown;
  cost_usd?: number;
  duration_ms?: number;
}

export type JobEventKind =
  | "info"
  | "user_text"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "result"
  | "error";

export interface JobEvent {
  ts: string;
  kind: JobEventKind;
  payload: unknown;
}

function jobsRoot(): string {
  return process.env.CHART_REVIEW_JOBS_ROOT ?? path.join(PLATFORM_ROOT, "jobs");
}
function jobDir(jobId: string): string { return path.join(jobsRoot(), jobId); }
function manifestPath(jobId: string): string { return path.join(jobDir(jobId), "manifest.json"); }
function statusPath(jobId: string): string { return path.join(jobDir(jobId), "status.json"); }
function transcriptPath(jobId: string): string { return path.join(jobDir(jobId), "transcript.jsonl"); }


export interface CreateJobInput {
  kind: JobKind;
  task_id?: string;
  started_by: string;
  payload?: Record<string, unknown>;
}

export function createJob(input: CreateJobInput): { manifest: JobManifest; status: JobStatus } {
  const ts = new Date().toISOString();
  const jobId = `${input.kind}-${ts.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  fs.mkdirSync(jobDir(jobId), { recursive: true });
  const manifest: JobManifest = {
    job_id: jobId,
    kind: input.kind,
    task_id: input.task_id,
    started_at: ts,
    started_by: input.started_by,
    payload: input.payload,
  };
  const status: JobStatus = {
    job_id: jobId,
    state: "running",
    started_at: ts,
    updated_at: ts,
    completed_at: null,
  };
  atomicWriteJson(manifestPath(jobId), manifest);
  atomicWriteJson(statusPath(jobId), status);
  fs.writeFileSync(transcriptPath(jobId), "");
  return { manifest, status };
}

export function appendJobEvent(jobId: string, ev: Omit<JobEvent, "ts">): JobEvent {
  const event: JobEvent = { ...ev, ts: new Date().toISOString() };
  fs.appendFileSync(transcriptPath(jobId), JSON.stringify(event) + "\n");
  return event;
}

export function updateJobStatus(jobId: string, patch: Partial<JobStatus>): JobStatus {
  const cur = getJobStatus(jobId);
  if (!cur) throw new Error(`job not found: ${jobId}`);
  const next: JobStatus = { ...cur, ...patch, updated_at: new Date().toISOString() };
  atomicWriteJson(statusPath(jobId), next);
  return next;
}

export function getJobManifest(jobId: string): JobManifest | null {
  const p = manifestPath(jobId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as JobManifest; }
  catch { return null; }
}

export function getJobStatus(jobId: string): JobStatus | null {
  const p = statusPath(jobId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as JobStatus; }
  catch { return null; }
}

export function readJobTranscript(jobId: string, opts?: { sinceLine?: number }): JobEvent[] {
  const p = transcriptPath(jobId);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  const start = opts?.sinceLine ?? 0;
  const out: JobEvent[] = [];
  for (let i = start; i < lines.length; i++) {
    try { out.push(JSON.parse(lines[i]) as JobEvent); }
    catch { /* skip malformed */ }
  }
  return out;
}

export function listJobs(filter?: { kind?: JobKind; task_id?: string; limit?: number }): JobManifest[] {
  const root = jobsRoot();
  if (!fs.existsSync(root)) return [];
  const out: JobManifest[] = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const m = getJobManifest(name);
    if (!m) continue;
    if (filter?.kind && m.kind !== filter.kind) continue;
    if (filter?.task_id && m.task_id !== filter.task_id) continue;
    out.push(m);
  }
  out.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return filter?.limit ? out.slice(0, filter.limit) : out;
}
