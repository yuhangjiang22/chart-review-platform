// Import a benchmark predictions.json batch into the platform NER tab as a
// reviewable iteration. Materializes PHI-safe corpus dirs (patient_real_*,
// gitignored), creates a session whose cohort is the imported patients, and
// writes session-scoped review_state.json files holding the gpt-5.2 spans.
//
// Run (loads .env so CHART_REVIEW_REVIEWS_ROOT etc. resolve):
//   set -a; source .env; set +a; \
//   npx tsx scripts/import-benchmark-ner.ts \
//     --predictions ../claude-agent-sdk-benchmark/results/ner_v3_test/predictions.json \
//     --notes-glob '../claude-agent-sdk-benchmark/data/notes_200/*.csv'
import fs from "node:fs";
import path from "node:path";
import { PLATFORM_ROOT, patientsRoot } from "@chart-review/patients";
import { writeReviewState, withReviewsRoot } from "@chart-review/domain-review";
import { createSession } from "@chart-review/domain-iter";
import { loadCompiledTask } from "@chart-review/tasks";
import {
  buildSpanLabel, buildReviewState, groupByPerson, assertOffsetsFaithful,
  type BenchPredictions,
} from "./lib/benchmark-ner-map.js";

// Canonical task_id is the bundle dir name WITHOUT the "chart-review-" prefix
// (loadCompiledTask / guidelineDir prepend it; the UI's /api/reviews/:taskId
// route also resolves the task via loadCompiledTask, so use the bare id here).
const TASK_ID = "bso-ad-ner";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

/** Resolve a "dir/*.csv"-style arg to concrete file paths via readdir
 *  (Node 20 has no stable fs/promises glob). Only the basename suffix
 *  after the leading "*" is matched, against a flat directory. */
function resolveNoteCsvs(globArg: string): string[] {
  const dir = path.dirname(globArg);
  const suffix = path.basename(globArg).replace(/^\*/, "");
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => path.join(dir, f));
}

/** Read all note CSVs into note_id -> {person_id, note_text}. Handles BOM. */
function readNotesCsv(files: string[]): Record<string, { person_id: string; note_text: string }> {
  const idx: Record<string, { person_id: string; note_text: string }> = {};
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf-8").replace(/^﻿/, "");
    const rows = parseCsv(raw);
    const header = rows[0];
    if (!header) continue;
    const cNote = header.indexOf("note_id");
    const cPerson = header.indexOf("person_id");
    const cText = header.indexOf("note_text");
    if (cNote < 0 || cText < 0) continue; // bso_ad_sample.csv uses row_id — skip
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row[cNote]) continue;
      idx[row[cNote]] = { person_id: row[cPerson] ?? "", note_text: row[cText] ?? "" };
    }
  }
  return idx;
}

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines). */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; }
    else if (ch === "\r") { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); out.push(row); }
  return out;
}

async function main() {
  const predPath = arg("predictions");
  const notesGlob = arg("notes-glob");
  const pred = JSON.parse(fs.readFileSync(predPath, "utf-8"));
  const predictions: BenchPredictions = pred.predictions;
  const model = pred.model ?? "gpt-5.2";

  const noteFiles = resolveNoteCsvs(notesGlob);
  if (!noteFiles.length) throw new Error(`no CSVs matched ${notesGlob}`);
  const notes = readNotesCsv(noteFiles);

  const task = loadCompiledTask(TASK_ID);
  if (!task) throw new Error(`task ${TASK_ID} not found — run from platform root`);
  const ontologyPin = `bso-ad@${pred.ontology_version ?? "2026.05.28-0"}`;
  const nowIso = new Date().toISOString();

  const byPerson = groupByPerson(predictions);
  const patientIds: string[] = [];
  const reviewStates: { patientId: string; state: ReturnType<typeof buildReviewState> }[] = [];

  for (const [personId, noteIds] of Object.entries(byPerson)) {
    const patientId = `patient_real_${personId}`;
    patientIds.push(patientId);
    // Compute the dir directly (patientDir() throws if it doesn't exist yet —
    // we are creating it). person_id is a numeric string from the CSV, so the
    // patient_real_<id> name carries no path-traversal risk.
    const pdir = path.join(patientsRoot(), patientId);
    fs.mkdirSync(path.join(pdir, "notes"), { recursive: true });

    const allSpans = [];
    const docNoteIds: string[] = [];
    for (const noteId of noteIds) {
      const src = notes[noteId];
      if (!src) throw new Error(`note ${noteId} not found in CSVs (needed for verbatim text)`);
      fs.writeFileSync(path.join(pdir, "notes", `${noteId}.txt`), src.note_text);
      docNoteIds.push(noteId);
      const spans = predictions[noteId].entities.map((e) => buildSpanLabel(noteId, e));
      assertOffsetsFaithful(src.note_text, spans, noteId);
      allSpans.push(...spans);
    }
    fs.writeFileSync(
      path.join(pdir, "meta.json"),
      JSON.stringify({ patient_id: patientId, source: "benchmark-import", person_id: personId, note_ids: docNoteIds, generated_by: "benchmark-import" }, null, 2) + "\n",
    );
    reviewStates.push({ patientId, state: buildReviewState(patientId, TASK_ID, allSpans, nowIso, ontologyPin) });
  }

  const session = createSession({
    task_id: TASK_ID,
    patient_ids: patientIds,
    started_by: "benchmark-import",
    name: `benchmark-import ${path.basename(path.dirname(predPath))} (${model})`,
  });

  const reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
  await withReviewsRoot(path.join(reviewsRoot, session.session_id), async () => {
    for (const { patientId, state } of reviewStates) {
      writeReviewState(patientId, TASK_ID, state);
    }
  });

  console.log(`[import] session ${session.session_id} created with ${patientIds.length} patient(s)`);
  console.log(`[import] patients: ${patientIds.join(", ")}`);
  console.log(`[import] total spans: ${reviewStates.reduce((n, r) => n + (r.state.span_labels?.length ?? 0), 0)}`);
  console.log(`[import] open the NER tab, select task ${TASK_ID} + session ${session.session_id} to VALIDATE.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
