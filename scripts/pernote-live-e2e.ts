// Live e2e for per-note labeling: runs the REAL per-note extractor against the
// synthetic demo patient's note via real OpenRouter, compares to per-note
// ground truth, and feeds the real output through the metrics helper.
// Run: node node_modules/tsx/dist/cli.mjs scripts/pernote-live-e2e.ts
import fs from "node:fs";
import path from "node:path";

// Repo root = cwd (run this from the chart-review-platform-concur directory).
const ROOT = process.env.CHART_REVIEW_PLATFORM_ROOT || process.cwd();

// Minimal .env load (the server uses dotenv; we replicate just enough).
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
process.env.CHART_REVIEW_PLATFORM_ROOT ||= ROOT;

const { loadCompiledTask } = await import("@chart-review/tasks");
const { extractLabelsForNote } = await import("@chart-review/pipeline-extract-pernote");
const { resolveModelEndpoint } = await import("../server/lib/model-registry.ts");
const { computePerNoteMetrics } = await import("../server/lib/pernote-performance.ts");

const PATIENT = "patient_acts_demo_01";
const NOTE_ID = "2026-02-10__memory_clinic";
const MODEL_KEY = "claude-sonnet"; // vllm → OpenRouter

const task = loadCompiledTask("acts"); // guidelineDir() prepends "chart-review-"
if (!task) throw new Error("ACTS task not found");
const endpoint = resolveModelEndpoint(MODEL_KEY, { modelsPath: path.join(ROOT, "python/models.json") });
if (!endpoint) throw new Error(`no endpoint for model '${MODEL_KEY}'`);
console.log(`endpoint: mode=${endpoint.mode} model=${endpoint.model} baseUrl=${endpoint.baseUrl}`);

const promptPreamble = fs.readFileSync(
  path.join(ROOT, ".claude/skills/chart-review-acts/references/pernote_prompt.md"), "utf8");

console.log(`\nrunning real per-note extraction on ${PATIENT} / ${NOTE_ID} …\n`);
const r = await extractLabelsForNote({ patientId: PATIENT, task, noteId: NOTE_ID, endpoint, promptPreamble });
if (r.error) throw new Error(`extractor error: ${r.error}`);

const gt = JSON.parse(fs.readFileSync(
  path.join(ROOT, "corpus/patients", PATIENT, "ground_truth.json"), "utf8")
).note_answers[NOTE_ID] as Record<string, string>;

let correct = 0;
const pairs = [];
for (const f of r.fields) {
  const exp = gt[f.field_id];
  const ok = f.answer === exp;
  if (ok) correct++;
  const ev = f.evidence?.[0]?.verbatim_quote ?? "(no evidence)";
  console.log(
    `  ${ok ? "✓" : "✗"} ${f.field_id.padEnd(18)} extracted=${String(f.answer).padEnd(4)} gt=${String(exp).padEnd(4)} ` +
    `conf=${f.confidence ?? "-"} | "${ev.slice(0, 60)}"`,
  );
  if (f.answer != null && exp != null) pairs.push({ note_id: NOTE_ID, field_id: f.field_id, a: String(f.answer), b: exp });
}
console.log(`\nlabel accuracy vs ground truth: ${correct}/${r.fields.length}`);

const metrics = computePerNoteMetrics(pairs, r.fields.map((f) => f.field_id));
console.log(`\nper-note metrics (extracted vs GT):`);
console.log(`  macro_accuracy=${metrics.macro_accuracy} overall_agreement=${metrics.overall_agreement}`);
for (const pf of metrics.per_field) console.log(`  ${pf.field_id.padEnd(18)} acc=${pf.accuracy} κ=${pf.kappa} n=${pf.n}`);
console.log(`  faithful evidence on: ${r.fields.filter((f) => (f.evidence?.length ?? 0) > 0).map((f) => f.field_id).join(", ")}`);
