// packages/deploy-runner/src/index.ts
// Headless deployment runner. See docs/superpowers/specs/2026-06-07-deployment-runner-design.md
import { parseArgs } from "node:util";
import fs from "node:fs";
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

/** Newest export dir under <exportsRoot>/<task>/. exportId embeds an ISO
 *  timestamp, so lexical sort = chronological; we also stat as a tiebreak. */
function latestPackageDir(taskId: string): string | null {
  const exportsRoot = process.env.CHART_REVIEW_EXPORTS_ROOT ?? path.join(PLATFORM_ROOT, "var", "exports");
  const taskDir = path.join(exportsRoot, taskId);
  if (!fs.existsSync(taskDir)) return null;
  const dirs = fs.readdirSync(taskDir)
    .map((n) => path.join(taskDir, n))
    .filter((p) => fs.statSync(p).isDirectory());
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0];
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      package: { type: "string" }, "data-dir": { type: "string" },
      out: { type: "string" }, agent: { type: "string" }, task: { type: "string" },
    },
  });
  const dataDir = values["data-dir"], outDir = values.out;
  if (!dataDir || !outDir) {
    console.error("usage: deploy --data-dir <dir> --out <dir> [--package <dir>] [--task <id>] [--agent <id>]");
    console.error("  --package omitted: uses the LATEST exported package for --task");
    return 2;
  }

  // Resolve the package: explicit --package wins; otherwise default to the
  // latest exported package for --task (so deploy runs what was last validated).
  let packageDir = values.package ?? null;
  if (!packageDir) {
    if (!values.task) {
      console.error("[deploy] no --package given and no --task to find the latest export for");
      return 2;
    }
    packageDir = latestPackageDir(values.task);
    if (!packageDir) {
      console.error(`[deploy] no exported package found for task ${values.task} (export one from the app first)`);
      return 2;
    }
    console.error(`[deploy] using latest exported package: ${packageDir}`);
  }

  // Load the platform's .env (Azure/vLLM creds, DEEPAGENTS_*, sidecar paths) so
  // the spawned deepagents sidecar has the same environment as a server run.
  // Does not override vars already set in the shell.
  dotenv.config({ path: path.join(PLATFORM_ROOT, ".env") });

  const pkg = loadPackage(path.resolve(packageDir));

  // Run the FROZEN rubric the package captured at export, not the later live
  // skill: point the criteria reader at <package>/skill. This propagates to the
  // stdio MCP server (every spawn spreads process.env), so list_criteria/
  // read_criteria serve the validated prompts.
  const frozenSkill = path.join(path.resolve(packageDir), "skill");
  if (fs.existsSync(path.join(frozenSkill, `chart-review-${pkg.taskId}`))) {
    process.env.CHART_REVIEW_GUIDELINES_ROOT = frozenSkill;
    console.error(`[deploy] rubric: frozen from package (${path.relative(path.resolve(packageDir), frozenSkill)})`);
  } else {
    console.error("[deploy] ⚠ package has no frozen rubric (older export) — falling back to the live skill");
  }
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
