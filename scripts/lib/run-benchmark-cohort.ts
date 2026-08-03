// Run the benchmark's Claude-Agent-SDK NER pipeline over a platform session's
// cohort and write the results as that session's NER review_state. Layer B of
// the benchmark→platform integration; reuses Layer A's mapping (benchmark-ner-map).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Minimal KEY=value .env parser: skip comments/blanks, strip surrounding quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export interface BenchmarkArgsInput {
  noteId: string;
  personId: string;
  noteFile: string;
  dataRoot: string;
  outRoot: string;
  model: string;
}

/** Assemble argv for `python3 <argv…>` running the benchmark per-note CLI. */
export function buildBenchmarkArgs(i: BenchmarkArgsInput): string[] {
  return [
    "run_benchmark.py", "ner",
    "--note-id", i.noteId,
    "--person-id", i.personId,
    "--text-file", i.noteFile,
    "--data-root", i.dataRoot,
    "--output-root", i.outRoot,
    "--model", i.model,
  ];
}

import type { BenchEntity } from "./benchmark-ner-map.js";
import { buildSpanLabel, buildReviewState, assertOffsetsFaithful } from "./benchmark-ner-map.js";
import { writeReviewState, withReviewsRoot } from "@chart-review/domain-review";
import { patientsRoot as defaultPatientsRoot } from "@chart-review/patients";

export type BenchNoteResult =
  | { ok: true; noteId: string; entities: BenchEntity[] }
  | { ok: false; noteId: string; error: string };

export interface RunOneNoteInput {
  pythonBin: string;
  benchmarkRoot: string;       // spawn cwd
  env: Record<string, string>; // merged over process.env for the child
  args: string[];              // from buildBenchmarkArgs
  noteId: string;
  outRoot: string;             // where <noteId>.json lands
}

/** Spawn the benchmark per-note CLI once; resolve to its parsed entities or an error. */
export function runOneNote(i: RunOneNoteInput): Promise<BenchNoteResult> {
  return new Promise((resolve) => {
    const child = spawn(i.pythonBin, i.args, {
      cwd: i.benchmarkRoot,
      env: { ...process.env, ...i.env },
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => resolve({ ok: false, noteId: i.noteId, error: err.message }));
    child.on("close", (code) => {
      const outFile = path.join(i.outRoot, `${i.noteId}.json`);
      if (code !== 0) {
        return resolve({ ok: false, noteId: i.noteId, error: `exit ${code}: ${stderr.slice(-2000)}` });
      }
      if (!fs.existsSync(outFile)) {
        return resolve({ ok: false, noteId: i.noteId, error: `no output at ${outFile}; stderr: ${stderr.slice(-2000)}` });
      }
      try {
        const json = JSON.parse(fs.readFileSync(outFile, "utf-8"));
        resolve({ ok: true, noteId: i.noteId, entities: (json.entities ?? []) as BenchEntity[] });
      } catch (e) {
        resolve({ ok: false, noteId: i.noteId, error: `bad output JSON: ${(e as Error).message}` });
      }
    });
  });
}

export interface CohortPatientResult {
  patientId: string;
  n_notes: number;
  n_spans: number;
  failures: { noteId: string; error: string }[];
}
export interface CohortRunSummary {
  sessionId: string;
  patients: CohortPatientResult[];
}

export interface RunCohortInput {
  sessionId: string;
  /** Platform task id the review_state is written under (path + in-file
   *  task_id). Defaults to "bso-ad-ner-sdk" — the vendored task. */
  taskId?: string;
  model: string;
  patientIds: string[];
  benchmarkRoot: string;
  dataRoot?: string;
  outRoot?: string;
  pythonBin?: string;
  env?: Record<string, string>;
  ontologyPin?: string;
  nowIso?: string;
  patientsRootOverride?: string;
  reviewsRootOverride?: string;
  runNote?: (i: RunOneNoteInput) => Promise<BenchNoteResult>;
  onProgress?: (msg: string) => void;
}

export async function runBenchmarkCohort(input: RunCohortInput): Promise<CohortRunSummary> {
  const taskId = input.taskId ?? "bso-ad-ner-sdk";
  const pRoot = input.patientsRootOverride ?? defaultPatientsRoot();
  const reviewsRoot = input.reviewsRootOverride
    ?? process.env.CHART_REVIEW_REVIEWS_ROOT
    ?? path.join(input.benchmarkRoot, "..", "chart-review-platform", "var", "reviews");
  const dataRoot = input.dataRoot ?? path.join(input.benchmarkRoot, "ontology");
  const outRoot = input.outRoot ?? path.join(reviewsRoot, "..", "benchmark-sdk", input.sessionId);
  // Default to the benchmark's OWN venv python — the vendored Claude-Agent-SDK
  // deps (claude_agent_sdk, fastmcp, …) live only in vendor/bso-ad-sdk/.venv
  // (Python 3.11). System python3 (often 3.9) can't import them and the child
  // dies with `ModuleNotFoundError: claude_agent_sdk` → 0 spans, all notes
  // "failed". Callers may still override via input.pythonBin.
  const venvPy = path.join(input.benchmarkRoot, ".venv", "bin", "python");
  const pythonBin = input.pythonBin ?? (fs.existsSync(venvPy) ? venvPy : "python3");
  const runNote = input.runNote ?? runOneNote;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const ontologyPin = input.ontologyPin ?? "bso-ad@2026.05.28-0";
  const log = input.onProgress ?? (() => {});

  fs.mkdirSync(outRoot, { recursive: true });
  const patients: CohortPatientResult[] = [];

  for (const patientId of input.patientIds) {
    const pdir = path.join(pRoot, patientId);
    let personId = patientId.replace(/^patient_real_/, "");
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(pdir, "meta.json"), "utf-8"));
      if (meta.person_id != null) personId = String(meta.person_id);
    } catch { /* fall back to stripped id */ }

    const notesDir = path.join(pdir, "notes");
    const noteFiles = fs.existsSync(notesDir)
      ? fs.readdirSync(notesDir).filter((f) => f.endsWith(".txt")).sort()
      : [];
    const failures: { noteId: string; error: string }[] = [];
    const allSpans: ReturnType<typeof buildSpanLabel>[] = [];

    for (const file of noteFiles) {
      const noteId = file.replace(/\.txt$/, "");
      const noteFile = path.join(notesDir, file);
      const noteText = fs.readFileSync(noteFile, "utf-8");
      log(`[run] ${patientId}/${noteId} …`);
      const res = await runNote({
        pythonBin, benchmarkRoot: input.benchmarkRoot, env: input.env ?? {},
        args: buildBenchmarkArgs({ noteId, personId, noteFile, dataRoot, outRoot, model: input.model }),
        noteId, outRoot,
      });
      if (!res.ok) { failures.push({ noteId, error: res.error }); continue; }
      try {
        const spans = res.entities.map((e) => buildSpanLabel(noteId, e));
        assertOffsetsFaithful(noteText, spans, noteId);
        allSpans.push(...spans);
      } catch (e) {
        failures.push({ noteId, error: (e as Error).message });
      }
    }

    const state = buildReviewState(patientId, taskId, allSpans, nowIso, ontologyPin);
    await withReviewsRoot(path.join(reviewsRoot, input.sessionId), async () => {
      writeReviewState(patientId, taskId, state);
    });
    patients.push({ patientId, n_notes: noteFiles.length, n_spans: allSpans.length, failures });
    log(`[done] ${patientId}: ${allSpans.length} spans, ${failures.length} failed notes`);
  }
  return { sessionId: input.sessionId, patients };
}
