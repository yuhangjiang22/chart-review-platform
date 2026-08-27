// In-process LCN real-data batch trigger (mirrors scripts/rucam-realtest/run.ts).
//
// Loads .env (Azure creds + CHART_REVIEW_PHI_MODEL) and runs the given
// patient_real_lcn_* fixtures through the real batch-run pipeline. Their
// meta.json has phi:true, so runOneAgent routes every agent call to the
// HIPAA-eligible Azure model (resolveAgentModel / modelFor("phi")). This
// script prints only run status + draft presence — no patient data.
//
// Usage (from platform root):
//   node_modules/.bin/tsx scripts/lcn-realtest/run.ts patient_real_lcn_xxx [...]
//   (no args = every patient_real_lcn_* fixture in the corpus — usually NOT
//    what you want; pass explicit ids.)
//
// luna ops notes (from the pilot): run at concurrency 1 (429s at 2); the
// SKILL read budget + cold rate windows keep a patient at ~35-50 tool calls,
// 15-25 min each on luna.

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

dotenv.config({ path: path.join(ROOT, ".env") });
process.env.CHART_REVIEW_PLATFORM_ROOT ??= ROOT;

const CORPUS = path.join(ROOT, "corpus", "patients");
const patients = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(CORPUS).filter((d) => d.startsWith("patient_real_lcn_")).sort();

if (patients.length === 0) {
  console.error("[run] FATAL: no patients given and no patient_real_lcn_* fixtures");
  process.exit(1);
}
if (!process.env.CHART_REVIEW_PHI_MODEL) {
  console.error("[run] FATAL: CHART_REVIEW_PHI_MODEL is unset — PHI patients must route to a HIPAA-eligible model. Set it in .env.");
  process.exit(1);
}

const batch = await import("@chart-review/infra-batch-run");
const { startBatchRun, getRunStatus, draftPath } = batch as any;

console.log(`[run] task=lcn-cirrhosis patients=${patients.length} [${patients.join(", ")}]`);
console.log(`[run] PHI model (Azure) = ${process.env.CHART_REVIEW_PHI_MODEL}`);

const { run_id } = startBatchRun({
  task_id: "lcn-cirrhosis",
  patient_ids: patients,
  started_by: "lcn-realtest",
  max_concurrency: Number(process.env.RUN_CONCURRENCY ?? 1),
  max_turns_per_patient: Number(process.env.RUN_MAX_TURNS ?? 120),
});
console.log(`[run] run_id=${run_id}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["complete", "complete_with_errors", "failed", "error"]);
let last = "";
let warned = false;
const deadlineMs = Date.now() + Number(process.env.RUN_DEADLINE_MIN ?? 300) * 60 * 1000;

for (;;) {
  await sleep(5000);
  const st = getRunStatus(run_id);
  if (st) {
    const cost = typeof st.total_cost_usd === "number" ? st.total_cost_usd.toFixed(3) : st.total_cost_usd;
    const line = `${st.state} complete=${st.n_complete}/${st.n_patients} err=${st.n_error} running=${st.n_running} cost=$${cost}`;
    if (line !== last) {
      console.log(`[run] ${new Date().toISOString()} ${line}`);
      last = line;
    }
    if (TERMINAL.has(st.state)) {
      console.log(`[run] TERMINAL: ${st.state}`);
      for (const [pid, ps] of Object.entries(st.per_patient ?? {})) {
        console.log(`[run]   ${pid}: ${(ps as any).state}  draft=${fs.existsSync(draftPath(run_id, pid)) ? "yes" : "NO"}`);
      }
      console.log(`RUN_ID=${run_id}`);
      process.exit(st.state.startsWith("complete") ? 0 : 2);
    }
  }
  if (Date.now() > deadlineMs && !warned) {
    // The batch runs IN-PROCESS: exiting here would kill it mid-patient and
    // orphan the sidecar. Deadline is therefore advisory — warn and keep
    // polling; stop the task externally (TaskStop) if it is truly hung.
    console.error(`[run] deadline exceeded (${process.env.RUN_DEADLINE_MIN ?? 300} min) — NOT exiting (in-process run would die mid-patient); stop externally if hung`);
    warned = true;
  }
}
