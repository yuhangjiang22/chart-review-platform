// Live e2e for per-note labeling: runs the REAL per-note extractor against the
// synthetic demo patient's note via real OpenRouter, writes the extracted
// leaves (which DERIVES apoe2/3/4 per note from apoe_genotype), then compares
// the full stored field set (leaves + derived) to per-note ground truth.
// Run: node node_modules/tsx/dist/cli.mjs scripts/pernote-live-e2e.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Repo root = cwd (run this from the chart-review-platform-concur directory).
const ROOT = process.env.CHART_REVIEW_PLATFORM_ROOT || process.cwd();

// Minimal .env load (the server uses dotenv; we replicate just enough).
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
process.env.CHART_REVIEW_PLATFORM_ROOT ||= ROOT;
// Isolate review-state writes to a throwaway dir (don't touch var/reviews).
process.env.CHART_REVIEW_REVIEWS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pernote-e2e-"));

const { loadCompiledTask } = await import("@chart-review/tasks");
const { extractLabelsForNote } = await import("@chart-review/pipeline-extract-pernote");
const { writePerNoteAssessments, load } = await import("@chart-review/domain-review");
const { resolveModelEndpoint } = await import("../server/lib/model-registry.ts");

const PATIENT = process.env.E2E_PATIENT || "patient_acts_demo_01";
const NOTE_ID = process.env.E2E_NOTE || "2026-02-10__memory_clinic";
const MODEL_KEY = "claude-sonnet"; // vllm → OpenRouter

const task = loadCompiledTask("acts"); // guidelineDir() prepends "chart-review-"
if (!task) throw new Error("ACTS task not found");
const endpoint = resolveModelEndpoint(MODEL_KEY, { modelsPath: path.join(ROOT, "python/models.json") });
if (!endpoint) throw new Error(`no endpoint for model '${MODEL_KEY}'`);
console.log(`endpoint: mode=${endpoint.mode} model=${endpoint.model}`);
console.log(`task fields: ${task.fields.map((f) => f.id + (f.derivation ? "*" : "")).join(", ")}  (* = derived)`);

const promptPreamble = fs.readFileSync(
  path.join(ROOT, ".claude/skills/chart-review-acts/references/pernote_prompt.md"), "utf8");

console.log(`\n1) real per-note extraction on ${PATIENT} / ${NOTE_ID} …`);
const r = await extractLabelsForNote({ patientId: PATIENT, task, noteId: NOTE_ID, endpoint, promptPreamble });
if (r.error) throw new Error(`extractor error: ${r.error}`);
console.log(`   extracted leaves: ${r.fields.map((f) => `${f.field_id}=${f.answer}`).join(", ")}`);

console.log(`2) write leaves → derive alleles per note …`);
writePerNoteAssessments(PATIENT, task, {
  noteId: NOTE_ID,
  label: NOTE_ID,
  fields: r.fields.map((f) => ({
    field_id: f.field_id, answer: f.answer, confidence: f.confidence, evidence: f.evidence, rationale: f.rationale,
  })),
});
const state = load(PATIENT, "acts");
const stored = new Map(
  (state?.field_assessments ?? [])
    .filter((a) => a.encounter_id === NOTE_ID)
    .map((a) => [a.field_id, a.answer == null ? undefined : String(a.answer)]),
);

const gt = JSON.parse(fs.readFileSync(path.join(ROOT, "corpus/patients", PATIENT, "ground_truth.json"), "utf8"))
  .note_answers[NOTE_ID] as Record<string, string>;

console.log(`3) compare stored (leaves + derived) vs ground truth:\n`);
// Normalized set for free-text comparison: lowercase, split on ; / , , trim, sort.
const norm = (s: string | undefined) =>
  (s ?? "").toLowerCase().split(/[;,]/).map((x) => x.trim()).filter(Boolean).sort().join(" | ");

const fieldIds = Object.keys(gt);
const strict: Array<{ fid: string; got?: string; exp?: string; ok: boolean; kind: string }> = [];
const freetext: Array<{ fid: string; got?: string; exp?: string; ok: boolean }> = [];
for (const fid of fieldIds) {
  const f = task.fields.find((ff) => ff.id === fid);
  const got = stored.get(fid);
  const exp = gt[fid] == null ? undefined : String(gt[fid]);
  if ((f?.answer_schema as { type?: string } | undefined)?.type === "string") {
    freetext.push({ fid, got, exp, ok: norm(got) === norm(exp) });
  } else {
    strict.push({ fid, got, exp, ok: got === exp, kind: f?.derivation ? "derived" : "leaf" });
  }
}
let correct = 0;
for (const s of strict) {
  if (s.ok) correct++;
  console.log(`  ${s.ok ? "✓" : "✗"} ${s.fid.padEnd(20)} ${s.kind.padEnd(8)} got=${String(s.got).padEnd(10)} gt=${s.exp}`);
}
console.log(`\nstrict accuracy (enum + numeric + derived) vs GT: ${correct}/${strict.length}`);
if (freetext.length) {
  console.log(`\nfree-text fields (normalized set match):`);
  for (const ft of freetext) {
    console.log(`  ${ft.ok ? "✓" : "~"} ${ft.fid.padEnd(18)} got="${ft.got ?? ""}"  gt="${ft.exp ?? ""}"`);
  }
}
console.log(`\nfaithful evidence on: ${r.fields.filter((f) => (f.evidence?.length ?? 0) > 0).map((f) => f.field_id).join(", ")}`);

fs.rmSync(process.env.CHART_REVIEW_REVIEWS_ROOT, { recursive: true, force: true });
