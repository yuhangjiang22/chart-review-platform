// In-process cost-test run for lung-cancer-adherence on a real PHI patient.
// meta.phi=true forces the Azure HIPAA model (gpt-5.2). Sets DEEPAGENTS_USAGE_LOG
// so we capture exact token usage → cost. Prints only run status (no PHI).
//
// Usage (from concur root):
//   node node_modules/tsx/dist/cli.mjs scripts/lung-realtest/run.ts [patient_id]
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONCUR_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(CONCUR_ROOT, ".env") });
process.env.CHART_REVIEW_PLATFORM_ROOT ??= CONCUR_ROOT;
process.env.DEEPAGENTS_USAGE_LOG ??= path.join(CONCUR_ROOT, "var/qa-logs/lung-usage.jsonl");

if (!process.env.CHART_REVIEW_PHI_MODEL) {
  console.error("[run] FATAL: CHART_REVIEW_PHI_MODEL unset — a PHI patient must route to a HIPAA model.");
  process.exit(1);
}

const patients = process.argv.slice(2).length ? process.argv.slice(2) : ["patient_real_cancer_01"];
const batch = await import("@chart-review/infra-batch-run");
const { startBatchRun, getRunStatus } = batch as any;

console.log(`[run] task=lung-cancer-adherence patients=[${patients.join(", ")}]`);
console.log(`[run] PHI model (Azure) = ${process.env.CHART_REVIEW_PHI_MODEL}`);
console.log(`[run] usage log = ${process.env.DEEPAGENTS_USAGE_LOG}`);

const { run_id } = startBatchRun({
  task_id: "lung-cancer-adherence",
  patient_ids: patients,
  started_by: "lung-realtest",
  max_concurrency: 1,
  max_turns_per_patient: Number(process.env.RUN_MAX_TURNS ?? 120),
  agent_specs: [{ id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default" }],
});
console.log(`[run] run_id=${run_id}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["complete", "complete_with_errors", "failed", "error"]);
const deadline = Date.now() + Number(process.env.RUN_DEADLINE_MIN ?? 30) * 60 * 1000;
let last = "";
for (;;) {
  await sleep(5000);
  const st = getRunStatus(run_id);
  if (st) {
    const line = `${st.state} complete=${st.n_complete}/${st.n_patients} err=${st.n_error} running=${st.n_running}`;
    if (line !== last) { console.log(`[run] ${line}`); last = line; }
    if (TERMINAL.has(st.state)) { console.log(`[run] TERMINAL ${st.state}`); console.log(`RUN_ID=${run_id}`); process.exit(0); }
  }
  if (Date.now() > deadline) { console.error("[run] timed out"); process.exit(3); }
}
