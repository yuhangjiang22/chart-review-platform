// In-process RUCAM real-data run trigger.
//
// Loads concur's .env (Azure creds + CHART_REVIEW_PHI_MODEL), points the
// RUCAM cohort dir at the real CSVs, and runs ONE patient through the real
// batch-run pipeline (startBatchRun -> runOneAgent). Because the fixture's
// meta.json has phi:true, runOneAgent routes the agent to the HIPAA-eligible
// Azure model (resolveAgentModel / modelFor("phi")). PHI never reaches the
// default backend, and this script prints only run status + the draft path —
// no patient data.
//
// Usage (from concur root):
//   CHART_REVIEW_RUCAM_DATA_DIR=$(cd ../RUCAM/data_v3 && pwd) \
//     node_modules/.bin/tsx scripts/rucam-realtest/run.ts [patient_id]
// NOTE: the corpus patient_real_rucam_* patients live in ../RUCAM/data_v3 (their
// person_ids are in data_v3's derived_rucam.csv/serology/etc.). data_v5 does NOT
// contain them — pointing there makes every RUCAM plugin tool return "No data
// found" and the agent extracts from notes only (or bails). Default is data_v3.
//
// Env must be set BEFORE importing the batch-run module (it reads model /
// platform-root config at load), so the package is imported dynamically.

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONCUR_ROOT = path.resolve(__dirname, "..", "..");

dotenv.config({ path: path.join(CONCUR_ROOT, ".env") });
process.env.CHART_REVIEW_PLATFORM_ROOT ??= CONCUR_ROOT;

const DATA_DIR =
  process.env.CHART_REVIEW_RUCAM_DATA_DIR ??
  path.resolve(CONCUR_ROOT, "..", "RUCAM", "data_v3");
process.env.CHART_REVIEW_RUCAM_DATA_DIR = DATA_DIR;

// Patients: explicit args, else every gitignored real fixture.
const CORPUS = path.join(CONCUR_ROOT, "corpus", "patients");
const patients = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(CORPUS).filter((d) => d.startsWith("patient_real_rucam_")).sort();

if (patients.length === 0) {
  console.error("[run] FATAL: no patients (none given and no patient_real_rucam_* fixtures)");
  process.exit(1);
}
if (!fs.existsSync(DATA_DIR)) {
  console.error(`[run] FATAL: RUCAM data dir not found: ${DATA_DIR}`);
  process.exit(1);
}
if (!process.env.CHART_REVIEW_PHI_MODEL) {
  console.error("[run] FATAL: CHART_REVIEW_PHI_MODEL is unset — a PHI patient must route to a HIPAA-eligible model. Set it in .env.");
  process.exit(1);
}

const batch = await import("@chart-review/infra-batch-run");
const { startBatchRun, getRunStatus, draftPath, perPatientDir } = batch as any;

console.log(`[run] task=rucam patients=${patients.length} [${patients.join(", ")}]`);
console.log(`[run] data_dir=${DATA_DIR}`);
console.log(`[run] PHI model (Azure) = ${process.env.CHART_REVIEW_PHI_MODEL}`);

const { run_id } = startBatchRun({
  task_id: "rucam",
  patient_ids: patients,
  started_by: "rucam-realtest",
  max_concurrency: Number(process.env.RUN_CONCURRENCY ?? 3),
  // Serial tool calls (parallel_tool_calls=False, see models.py) need more
  // turns to read the same number of notes, so give generous headroom. RUCAM
  // is tool-intensive: 24 leaf components, each needing search_notes +
  // structured tools + offset-finding, so a thorough review legitimately makes
  // 80-100+ tool calls. recursion_limit = max_turns*2+10 (see __main__.py); at
  // the old 120 (=250) a thorough patient completes set_review_status but tips
  // over during the finalize tail and errors WITHOUT persisting the draft. 200
  // (=410) leaves ample margin for ~135 tool calls.
  max_turns_per_patient: Number(process.env.RUN_MAX_TURNS ?? 200),
});
console.log(`[run] run_id=${run_id}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["complete", "complete_with_errors", "failed", "error"]);
let last = "";
// Serial tool calls (parallel_tool_calls=False) make note-heavy patients slow;
// a too-tight cap cuts the driver mid-patient (orphaning a sidecar). Generous.
const deadlineMs = Date.now() + Number(process.env.RUN_DEADLINE_MIN ?? 90) * 60 * 1000;

for (;;) {
  await sleep(4000);
  const st = getRunStatus(run_id);
  if (st) {
    const cost = typeof st.total_cost_usd === "number" ? st.total_cost_usd.toFixed(3) : st.total_cost_usd;
    const line = `${st.state} complete=${st.n_complete}/${st.n_patients} err=${st.n_error} running=${st.n_running} cost=$${cost}`;
    if (line !== last) {
      console.log(`[run] ${line}`);
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
  if (Date.now() > deadlineMs) {
    console.error("[run] timed out after 25 min");
    process.exit(3);
  }
}
