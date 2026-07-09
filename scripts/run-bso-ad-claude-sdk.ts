// CLI: run the benchmark Claude-Agent-SDK NER pipeline over a platform session's
// cohort and write per-patient review_state for VALIDATE in the NER tab.
//
// Run:  npx tsx scripts/run-bso-ad-claude-sdk.ts --session-id session_003 [--model gpt-5.2]
// Requires the Azure proxy running (ANTHROPIC_BASE_URL from <benchmark>/.env).
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { getSessionManifest, importPilotIteration } from "@chart-review/domain-iter";
import { runDir, manifestPath as runManifestPath, statusPath as runStatusPath } from "@chart-review/infra-batch-run";
import { parseEnvFile, runBenchmarkCohort } from "./lib/run-benchmark-cohort.js";

const TASK_ID = "bso-ad-ner-sdk";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function checkTcp(host: string, port: number, ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

async function main() {
  const sessionId = arg("session-id");
  const model = arg("model", "gpt-5.2");
  // Optional status file: when set, write coarse run progress as JSON so a UI
  // (server /api/ner-sdk/run-status) can poll it. Absent → behave as before.
  const statusFile = (() => {
    const i = process.argv.indexOf("--status-file");
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
  })();
  const nowIso = () => new Date().toISOString();
  function writeStatus(obj: Record<string, unknown>): void {
    if (!statusFile) return;
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      const tmp = `${statusFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, statusFile);
    } catch { /* status is best-effort */ }
  }
  // Self-contained: default to the vendored runner inside the platform, NOT the
  // external benchmark repo. BENCHMARK_ROOT env still overrides if needed.
  const benchmarkRoot = path.resolve(
    process.env.BENCHMARK_ROOT ?? path.join(PLATFORM_ROOT, "vendor", "bso-ad-sdk"),
  );

  // Preflight 1: benchmark layout
  for (const rel of ["run_benchmark.py", "ontology/concepts.json", ".env"]) {
    if (!fs.existsSync(path.join(benchmarkRoot, rel))) {
      throw new Error(`benchmark missing ${rel} under ${benchmarkRoot} (set BENCHMARK_ROOT)`);
    }
  }
  const env = parseEnvFile(fs.readFileSync(path.join(benchmarkRoot, ".env"), "utf-8"));

  // Preflight 2: Azure proxy reachable. The benchmark talks to the model
  // through a LOCAL proxy (claude_proxy on :18080) that the benchmark README
  // says to start separately and address via ANTHROPIC_BASE_URL — it is NOT
  // in the benchmark .env, so default to the standard local proxy. AZURE_*
  // creds (which ARE in .env) get injected via `env` and folded into the api
  // key by the benchmark's providers.py.
  // Use || (not ??) so an EMPTY-string ANTHROPIC_BASE_URL — which the platform
  // server sets and a detached child inherits — falls through to the local proxy
  // default instead of producing `new URL("")` → "Invalid URL".
  const baseUrl = env.ANTHROPIC_BASE_URL
    || process.env.ANTHROPIC_BASE_URL
    || "http://127.0.0.1:18080";
  env.ANTHROPIC_BASE_URL = baseUrl; // ensure the spawned benchmark sees it
  const u = new URL(baseUrl);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (!(await checkTcp(u.hostname, port))) {
    throw new Error(`proxy not reachable at ${baseUrl} — start the benchmark proxy first (see benchmark README: uvicorn claude_proxy.proxy:app --port 18080)`);
  }

  // Preflight 3: session + cohort
  const session = getSessionManifest(TASK_ID, sessionId);
  if (!session) throw new Error(`session ${sessionId} not found for task ${TASK_ID}`);
  const patientIds = session.cohort?.patient_ids ?? [];
  if (!patientIds.length) throw new Error(`session ${sessionId} has an empty cohort`);

  const reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
  console.log(`[sdk-run] session ${sessionId}: ${patientIds.length} patient(s), model ${model}, proxy ${baseUrl}`);

  let done = 0;
  const total = patientIds.length;
  writeStatus({ state: "running", session_id: sessionId, total, done, started_at: nowIso() });

  const summary = await runBenchmarkCohort({
    sessionId, taskId: TASK_ID, model, patientIds, benchmarkRoot, env,
    reviewsRootOverride: reviewsRoot,
    outRoot: path.join(PLATFORM_ROOT, "var", "benchmark-sdk", sessionId),
    onProgress: (m) => {
      console.log(m);
      if (/^\[done\] /.test(m)) {
        done += 1;
        writeStatus({ state: "running", session_id: sessionId, total, done, started_at: nowIso() });
      }
    },
  });

  const totalSpans = summary.patients.reduce((n, p) => n + p.n_spans, 0);
  const totalFail = summary.patients.reduce((n, p) => n + p.failures.length, 0);
  console.log(`[sdk-run] done: ${summary.patients.length} patient(s), ${totalSpans} spans, ${totalFail} failed note(s)`);
  for (const p of summary.patients) {
    if (p.failures.length) console.log(`  ${p.patientId}: ${p.failures.map((f) => `${f.noteId}(${f.error.slice(0, 80)})`).join("; ")}`);
  }
  // Materialize a platform run + iter so the VALIDATE phase recognizes this run
  // (VALIDATE gates on a pilot iteration, not just review_state). Write the run
  // manifest + status (patient_ids + per-patient complete/error) and adopt it as
  // a ready_to_validate iter — no agent work is re-run; review_state is already
  // written under the session by runBenchmarkCohort.
  const runId = `sdk-${sessionId}-${Date.now()}`;
  const runStartedAt = nowIso();
  const isError = (p: { n_spans: number; failures: unknown[] }) => p.n_spans === 0 && p.failures.length > 0;
  fs.mkdirSync(runDir(runId), { recursive: true });
  fs.writeFileSync(runManifestPath(runId), JSON.stringify({
    run_id: runId, label: `vendored-sdk ${sessionId}`, task_id: TASK_ID,
    guideline_sha: "sdk-vendored", started_at: runStartedAt, started_by: "vendored-sdk",
    patient_ids: patientIds, max_concurrency: 1, max_turns_per_patient: 200,
    model, cost_cap_usd: 50, kind: "agent_batch_run", session_id: sessionId,
    agent_specs: [{ id: "agent_1", role_preset: "default", role_version: "v1" }],
  }, null, 2));
  const perPatient: Record<string, { state: string; completed_at: string }> = {};
  for (const p of summary.patients) perPatient[p.patientId] = { state: isError(p) ? "error" : "complete", completed_at: runStartedAt };
  fs.writeFileSync(runStatusPath(runId), JSON.stringify({
    run_id: runId, state: totalFail > 0 ? "complete_with_errors" : "complete",
    started_at: runStartedAt, updated_at: runStartedAt, completed_at: runStartedAt,
    total_cost_usd: 0, n_patients: summary.patients.length,
    n_complete: summary.patients.filter((p) => !isError(p)).length,
    n_error: summary.patients.filter(isError).length, n_running: 0, per_patient: perPatient,
  }, null, 2));
  const iter = importPilotIteration({ task_id: TASK_ID, run_id: runId, session_id: sessionId, started_by: "vendored-sdk" });
  console.log(`[sdk-run] created iter ${iter.pilot.iter_id} (${iter.pilot.state}) for VALIDATE.`);

  console.log(`[sdk-run] open NER tab → task ${TASK_ID} + session ${sessionId} to VALIDATE.`);
  writeStatus({
    state: "complete", session_id: sessionId, total,
    done: summary.patients.length,
    n_spans: summary.patients.reduce((n, p) => n + p.n_spans, 0),
    failed_notes: summary.patients.reduce((n, p) => n + p.failures.length, 0),
    finished_at: nowIso(),
  });
}

main().catch((e) => {
  const i = process.argv.indexOf("--status-file");
  const sf = i >= 0 ? process.argv[i + 1] : null;
  if (sf) {
    try {
      fs.mkdirSync(path.dirname(sf), { recursive: true });
      fs.writeFileSync(sf, JSON.stringify({ state: "error", message: e.message ?? String(e) }, null, 2));
    } catch { /* best-effort */ }
  }
  console.error(e.message ?? e);
  process.exit(1);
});
