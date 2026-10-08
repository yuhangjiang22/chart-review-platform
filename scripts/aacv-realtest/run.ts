// AACV rubric — real-note run. PRINTS NO PATIENT DATA.
//
// phi:true fixtures route to CHART_REVIEW_PHI_MODEL (HIPAA lane) via
// resolveAgentModel; PHI never reaches the default backend. This driver prints
// run status and per-criterion ANSWER LABELS only — never quotes, rationales,
// note text, or demographics.
//
// Usage: node_modules/.bin/tsx scripts/aacv-realtest/run.ts <patient_id ...>

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(ROOT, ".env") });
process.env.CHART_REVIEW_PLATFORM_ROOT ??= ROOT;

const patients = process.argv.slice(2);
if (!patients.length) { console.error("[run] FATAL: name the patients explicitly"); process.exit(1); }
if (!process.env.CHART_REVIEW_PHI_MODEL) {
  console.error("[run] FATAL: CHART_REVIEW_PHI_MODEL unset — a phi patient must route to a HIPAA-eligible model.");
  process.exit(1);
}

const batch = await import("@chart-review/infra-batch-run");
const { startBatchRun, getRunStatus, draftPath } = batch as any;

console.log(`[run] task=aacv patients=${patients.length}`);
console.log(`[run] PHI model = ${process.env.CHART_REVIEW_PHI_MODEL}`);

// SEARCH_MODE=comprehensive switches the agent from the default keyword-driven
// smart-search to the exhaustive read procedure. Everything else is unchanged,
// so two runs differing only in this variable isolate the search-mode effect.
const searchMode = process.env.SEARCH_MODE;
if (searchMode) console.log(`[run] search mode = ${searchMode}`);

const { run_id } = startBatchRun({
  task_id: "aacv",
  patient_ids: patients,
  started_by: "aacv-realtest",
  max_concurrency: 1,
  max_turns_per_patient: Number(process.env.RUN_MAX_TURNS ?? 80),
  ...(searchMode
    ? { agent_specs: [{ id: "agent_1", search_mode_preset: searchMode, role_version: "v1" }] }
    : {}),
  // TARGET_FIELDS=a,b,c runs criterion-focused mode: the agent answers only
  // these field_ids. Splitting 38 criteria into small groups is the lever that
  // actually changes retrieval depth — with few criteria in scope, the agent's
  // single up-front search pass has to cover them.
  ...(process.env.TARGET_FIELDS
    ? { target_field_ids: process.env.TARGET_FIELDS.split(",").map((s) => s.trim()).filter(Boolean) }
    : {}),
});
console.log(`[run] run_id=${run_id}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["complete", "complete_with_errors", "failed", "error"]);
let last = "";
const deadlineMs = Date.now() + Number(process.env.RUN_DEADLINE_MIN ?? 45) * 60 * 1000;

for (;;) {
  await sleep(5000);
  const st = getRunStatus(run_id);
  if (st) {
    const cost = typeof st.total_cost_usd === "number" ? st.total_cost_usd.toFixed(3) : st.total_cost_usd;
    const line = `${st.state} complete=${st.n_complete}/${st.n_patients} err=${st.n_error} running=${st.n_running} cost=$${cost}`;
    if (line !== last) { console.log(`[run] ${line}`); last = line; }
    if (TERMINAL.has(st.state)) {
      console.log(`[run] TERMINAL: ${st.state}`);
      for (const pid of patients) {
        const dp = draftPath(run_id, pid);
        if (!fs.existsSync(dp)) { console.log(`[run]   ${pid}: NO DRAFT`); continue; }
        const d = JSON.parse(fs.readFileSync(dp, "utf8"));
        const rows = (d.field_assessments ?? []).map((a: any) =>
          `${a.field_id}=${a.answer}${(a.evidence ?? []).length ? "" : "(no-ev)"}`);
        console.log(`[run]   ${pid}: ${rows.join("  ")}`);
      }
      // Post-run flag-only lint: mechanical rule check, prints labels/coords only,
      // writes var/runs/<run_id>/lint_report.json. Never modifies drafts; never fails the run.
      try {
        const { execFileSync } = await import("node:child_process");
        const out = execFileSync("python3", [path.join(ROOT, "scripts", "aacv-qa", "lint_drafts.py"), run_id], { encoding: "utf8" });
        process.stdout.write(out);
      } catch (e: any) {
        if (e?.stdout) process.stdout.write(String(e.stdout)); // lint exits 1 when violations exist — still print
        else console.error("[run] lint failed to execute (non-fatal)");
      }
      console.log(`RUN_ID=${run_id}`);
      process.exit(st.state.startsWith("complete") ? 0 : 2);
    }
  }
  if (Date.now() > deadlineMs) { console.error("[run] deadline — run continues, poll var/runs/"); process.exit(3); }
}
