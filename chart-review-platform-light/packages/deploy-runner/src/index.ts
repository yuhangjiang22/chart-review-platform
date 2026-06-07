// packages/deploy-runner/src/index.ts
// Headless deployment runner. See docs/superpowers/specs/2026-06-07-deployment-runner-design.md
import { parseArgs } from "node:util";
import path from "node:path";
import dotenv from "dotenv";
import { startBatchRun, getRunStatus } from "@chart-review/infra-batch-run";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { loadPackage } from "./load-package.js";
import { selectAgent } from "./select-agent.js";
import { enumeratePatients } from "./enumerate-patients.js";
import { resolveEnvModel } from "./env-model.js";
import { collectResults } from "./collect-results.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      package: { type: "string" }, "data-dir": { type: "string" },
      out: { type: "string" }, agent: { type: "string" },
    },
  });
  const packageDir = values.package, dataDir = values["data-dir"], outDir = values.out;
  if (!packageDir || !dataDir || !outDir) {
    console.error("usage: deploy --package <dir> --data-dir <dir> --out <dir> [--agent <id>]");
    return 2;
  }

  // Load the platform's .env (Azure/vLLM creds, DEEPAGENTS_*, sidecar paths) so
  // the spawned deepagents sidecar has the same environment as a server run.
  // Does not override vars already set in the shell.
  dotenv.config({ path: path.join(PLATFORM_ROOT, ".env") });

  const pkg = loadPackage(path.resolve(packageDir));
  const choice = selectAgent(pkg.agentConfig, pkg.performance, values.agent);
  console.error(`[deploy] task=${pkg.taskId} agent=${choice.spec.id} (${choice.reason})`);

  // Model warning (does not block).
  const env = resolveEnvModel();
  const recorded = pkg.agentConfig.find((a) => a.id === choice.spec.id)?.model ?? null;
  let modelWarning: string | null = null;
  if (recorded && env.model && recorded !== env.model) {
    modelWarning = `package validated on ${recorded} but env model is ${env.model}`;
    console.error(`[deploy] ⚠ ${modelWarning}`);
  }

  const patientIds = enumeratePatients(path.resolve(dataDir));
  if (patientIds.length === 0) { console.error("[deploy] no patients found under --data-dir"); return 2; }
  console.error(`[deploy] ${patientIds.length} patient(s) to run`);

  // Point note-reading at the new cohort; the sidecar inherits this env.
  process.env.CHART_REVIEW_PATIENTS_ROOT = path.resolve(dataDir);

  const { run_id } = startBatchRun({
    task_id: pkg.taskId,
    patient_ids: patientIds,
    started_by: "deploy-runner",
    agent_specs: [choice.spec],
    provider: "deepagents",
  });
  console.error(`[deploy] run ${run_id} started; waiting…`);

  // Poll to completion (the async batch loop runs on this event loop).
  let status = getRunStatus(run_id);
  while (status && status.state === "running") {
    await sleep(2000);
    status = getRunStatus(run_id);
    if (status) console.error(`[deploy]   ${status.n_complete}/${patientIds.length} done, ${status.n_error} failed`);
  }
  if (!status) { console.error("[deploy] run status disappeared"); return 1; }

  const res = collectResults({
    runId: run_id, status, agentId: choice.spec.id, fieldIds: pkg.fieldIds,
    outDir: path.resolve(outDir),
    meta: {
      package_dir: path.resolve(packageDir), task_id: pkg.taskId, agent_reason: choice.reason,
      model: recorded, env_model: env.model, model_mismatch_warning: modelWarning,
      data_dir: path.resolve(dataDir),
    },
  });
  console.error(`[deploy] done — ${res.n_ok} ok, ${res.n_failed} failed → ${path.resolve(outDir)}`);
  return res.n_ok === 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[deploy] error: ${(e as Error).message}`);
  process.exit(1);
});
