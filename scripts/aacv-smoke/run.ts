// AACV rubric smoke test — SYNTHETIC patients only.
//
// Runs the five draft AACV criterion files (.claude/skills/chart-review-aacv)
// against a synthetic patient to validate the rubric format and the shape of
// the output. This is pipeline validation, not a clinical test: the corpus has
// no Alzheimer's cohort, so most criteria are expected to return `unknown`.
//
// SYNTHETIC ONLY. patient_fake_* fixtures are phi:false and route to the
// default backend. Do not point this at patient_real_* — real-note processing
// is gated on task 03.5 (permitted environment), which is still open.
//
// Usage (from platform root):
//   node_modules/.bin/tsx scripts/aacv-smoke/run.ts [patient_id ...]

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

dotenv.config({ path: path.join(ROOT, ".env") });
process.env.CHART_REVIEW_PLATFORM_ROOT ??= ROOT;

const patients = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["patient_fake_bso_ad_01"];

const real = patients.filter((p) => !p.startsWith("patient_fake_"));
if (real.length) {
  console.error(`[run] FATAL: synthetic only. Refusing: ${real.join(", ")}`);
  console.error("[run] Real-note processing is gated on task 03.5.");
  process.exit(1);
}

const skill = path.join(ROOT, ".claude", "skills", "chart-review-aacv");
if (!fs.existsSync(skill)) {
  console.error(`[run] FATAL: rubric not found at ${skill}`);
  process.exit(1);
}
const criteria = fs
  .readdirSync(path.join(skill, "references", "criteria"))
  .filter((f) => f.endsWith(".md"));

const batch = await import("@chart-review/infra-batch-run");
const { startBatchRun, getRunStatus, draftPath } = batch as any;

console.log(`[run] task=aacv  criteria=${criteria.length}  patients=${patients.join(", ")}`);
console.log(`[run] backend=${process.env.DEEPAGENTS_LLM_BACKEND ?? "default"}  model=${process.env.CHART_REVIEW_MODEL ?? "(default)"}`);

const { run_id } = startBatchRun({
  task_id: "aacv",
  patient_ids: patients,
  started_by: "aacv-smoke",
  max_concurrency: 1,
  max_turns_per_patient: Number(process.env.RUN_MAX_TURNS ?? 60),
});
console.log(`[run] run_id=${run_id}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["complete", "complete_with_errors", "failed", "error"]);
let last = "";
const deadlineMs = Date.now() + Number(process.env.RUN_DEADLINE_MIN ?? 20) * 60 * 1000;

for (;;) {
  await sleep(4000);
  const st = getRunStatus(run_id);
  if (st) {
    const cost = typeof st.total_cost_usd === "number" ? st.total_cost_usd.toFixed(3) : st.total_cost_usd;
    const line = `${st.state} complete=${st.n_complete}/${st.n_patients} err=${st.n_error} running=${st.n_running} cost=$${cost}`;
    if (line !== last) { console.log(`[run] ${line}`); last = line; }
    if (TERMINAL.has(st.state)) {
      console.log(`[run] TERMINAL: ${st.state}`);
      for (const [pid, ps] of Object.entries(st.per_patient ?? {})) {
        console.log(`[run]   ${pid}: ${(ps as any).state}  draft=${fs.existsSync(draftPath(run_id, pid)) ? "yes" : "NO"}`);
      }
      console.log(`RUN_ID=${run_id}`);
      process.exit(st.state.startsWith("complete") ? 0 : 2);
    }
  }
  if (Date.now() > deadlineMs) {
    console.error("[run] deadline reached — NOT killing, run continues. Poll var/runs/ for the result.");
    process.exit(3);
  }
}
