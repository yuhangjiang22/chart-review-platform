# Deployment Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless CLI that runs an exported package's best agent on a new cohort directory and writes per-patient drafts + a summary CSV + a run manifest.

**Architecture:** A thin Node/TS CLI (`packages/deploy-runner`, run via `tsx`) that reuses `startBatchRun` from `@chart-review/infra-batch-run` — same prompt, deepagents sidecar, MCP, and faithfulness gate as the UI. It points note-reading at `--data-dir` via a new `CHART_REVIEW_PATIENTS_ROOT` env override, runs a single selected agent, polls the run to completion, and writes results.

**Tech Stack:** TypeScript, Node `util.parseArgs`, Vitest. Reuses `startBatchRun`/`getRunStatus`/`agentDraftPath`.

**Spec:** `docs/superpowers/specs/2026-06-07-deployment-runner-design.md`

---

## Key facts (verified)

- `startBatchRun(opts: StartBatchRunOptions): { run_id: string }` — `opts`: `task_id`, `patient_ids`, `started_by`, optional `agent_specs: AgentSpec[]`, `provider`. Fire-and-forget: runs an async loop on the same event loop; returns immediately. (`@chart-review/infra-batch-run`)
- `getRunStatus(runId): RunStatus | null` — `RunStatus.state` ∈ `running | complete | complete_with_errors | failed | aborted_cost_cap`; `.per_patient: Record<pid, { state: "pending"|"running"|"complete"|"error"; error? }>`; `.n_complete`, `.n_error`.
- `agentDraftPath(runId, patientId, agentId): string` — the promoted draft `var/runs/<runId>/per_patient/<pid>/agents/<agentId>.json` (a `{ field_assessments: [...] }` doc). A failed agent writes `<agentId>.error.json` instead (B1) and the patient's `per_patient` state is `error`.
- Notes resolve via `PATIENTS_ROOT = CORPUS_ROOT/patients` (`packages/patients/src/index.ts:27-29`). The deepagents provider spawns the sidecar with `{ ...process.env }`, so an env var set before `startBatchRun` reaches the MCP subprocess.
- `AgentSpec` (`@chart-review/agent-specs`): `{ id, search_mode_preset?, interpretation_preset?, role_preset?, role_prompt?, model? }`.
- Package files: `task.json` = `{ task_id, fields: [{field_id,...}], agent_config: [{id, search_mode_preset, interpretation_preset, model}] }`; `performance.json` = `{ agents: [{ agent_id, avg_accuracy: number|null }] }`.

## File Structure

- `packages/patients/src/index.ts` — **modify.** `PATIENTS_ROOT` gains a `CHART_REVIEW_PATIENTS_ROOT` override.
- `packages/deploy-runner/package.json` — **new.** Workspace package metadata + deps.
- `packages/deploy-runner/src/load-package.ts` — **new.** Parse + validate an export package.
- `packages/deploy-runner/src/select-agent.ts` — **new.** Choose the agent spec (best/override/fallback).
- `packages/deploy-runner/src/enumerate-patients.ts` — **new.** List patient ids from a data_dir.
- `packages/deploy-runner/src/env-model.ts` — **new.** Resolve the env model (mirrors the server route).
- `packages/deploy-runner/src/collect-results.ts` — **new.** Read drafts → write `<pid>.json` + `results.csv` + `run_manifest.json`.
- `packages/deploy-runner/src/index.ts` — **new.** CLI entry: parse args, orchestrate, poll, report.
- `packages/deploy-runner/src/*.test.ts` — **new.** Unit tests per module.
- `package.json` (root) — **modify.** Add the `deploy` script.
- `README.md` — **modify.** "Deploy on a larger cohort" section.

---

### Task 1: `CHART_REVIEW_PATIENTS_ROOT` override

**Files:**
- Modify: `packages/patients/src/index.ts:27-29`
- Test: `packages/patients/src/patients-root.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/patients/src/patients-root.test.ts
import { describe, it, expect } from "vitest";

describe("PATIENTS_ROOT override", () => {
  it("honors CHART_REVIEW_PATIENTS_ROOT when set", async () => {
    process.env.CHART_REVIEW_PATIENTS_ROOT = "/tmp/my-cohort";
    const mod = await import(`./index.js?patients-root-test=${Date.now()}`);
    expect(mod.PATIENTS_ROOT).toBe("/tmp/my-cohort");
    delete process.env.CHART_REVIEW_PATIENTS_ROOT;
  });
});
```

- [ ] **Step 2: Run → FAIL**
Run: `npx vitest run packages/patients/src/patients-root.test.ts`
Expected: FAIL — `PATIENTS_ROOT` ignores the env var (it's `CORPUS_ROOT/patients`).

- [ ] **Step 3: Implement** — change `packages/patients/src/index.ts`:
```ts
export const PATIENTS_ROOT =
  process.env.CHART_REVIEW_PATIENTS_ROOT ?? path.join(CORPUS_ROOT, "patients");
```
(Keep `CORPUS_ROOT` as-is; only `PATIENTS_ROOT` gains the override.)

- [ ] **Step 4: Run → PASS**
Run: `npx vitest run packages/patients/src/patients-root.test.ts`
Expected: PASS. Then `npm run typecheck` → no errors.

> Note: if the dynamic-import cache-bust query string doesn't re-evaluate the module constant in this Vitest setup, fall back to asserting via a small exported helper `patientsRoot()` that reads the env at call time. Read the existing file first; prefer the const override if the test passes.

- [ ] **Step 5: Commit**
```bash
cd <repo>
git add chart-review-platform-light/packages/patients/src/index.ts chart-review-platform-light/packages/patients/src/patients-root.test.ts
git commit -m "feat(light): CHART_REVIEW_PATIENTS_ROOT override for the deploy runner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: deploy-runner package scaffold + `loadPackage`

**Files:**
- Create: `packages/deploy-runner/package.json`
- Create: `packages/deploy-runner/src/load-package.ts`
- Test: `packages/deploy-runner/src/load-package.test.ts`

- [ ] **Step 1: Create the package.json**
```json
{
  "name": "@chart-review/deploy-runner",
  "version": "0.1.0",
  "private": true,
  "description": "Headless CLI: run an exported package's best agent on a new cohort dir.",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "dependencies": {
    "@chart-review/infra-batch-run": "*",
    "@chart-review/agent-specs": "*",
    "@chart-review/patients": "*"
  }
}
```

- [ ] **Step 2: Write the failing test**
```ts
// packages/deploy-runner/src/load-package.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPackage } from "./load-package.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function writePkg(task: unknown, perf: unknown) {
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task));
  fs.writeFileSync(path.join(dir, "performance.json"), JSON.stringify(perf));
}

describe("loadPackage", () => {
  it("parses a valid package", () => {
    writePkg(
      { task_id: "t1", fields: [{ field_id: "cancer_type" }, { field_id: "disease_extent" }],
        agent_config: [{ id: "agent_1", model: "gpt-4o" }, { id: "agent_2", model: "gpt-4o" }] },
      { agents: [{ agent_id: "agent_1", avg_accuracy: 1 }, { agent_id: "agent_2", avg_accuracy: 0.5 }] },
    );
    const p = loadPackage(dir);
    expect(p.taskId).toBe("t1");
    expect(p.fieldIds).toEqual(["cancer_type", "disease_extent"]);
    expect(p.agentConfig.map((a) => a.id)).toEqual(["agent_1", "agent_2"]);
    expect(p.performance.agents[0].avg_accuracy).toBe(1);
  });

  it("throws a clear error when task.json is missing", () => {
    fs.writeFileSync(path.join(dir, "performance.json"), JSON.stringify({ agents: [] }));
    expect(() => loadPackage(dir)).toThrow(/task\.json/);
  });

  it("throws a clear error when task.json is malformed", () => {
    fs.writeFileSync(path.join(dir, "task.json"), "{ not json");
    fs.writeFileSync(path.join(dir, "performance.json"), JSON.stringify({ agents: [] }));
    expect(() => loadPackage(dir)).toThrow(/task\.json/);
  });
});
```

- [ ] **Step 3: Run → FAIL**
Run: `npx vitest run packages/deploy-runner/src/load-package.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `load-package.ts`**
```ts
// packages/deploy-runner/src/load-package.ts
import fs from "node:fs";
import path from "node:path";

export interface AgentConfigEntry {
  id: string;
  search_mode_preset?: string;
  interpretation_preset?: string;
  role_prompt?: string;
  model?: string;
}
export interface PerfReport {
  agents: Array<{ agent_id: string; avg_accuracy: number | null }>;
}
export interface LoadedPackage {
  taskId: string;
  fieldIds: string[];
  agentConfig: AgentConfigEntry[];
  performance: PerfReport;
}

function readJson(file: string, label: string): unknown {
  if (!fs.existsSync(file)) throw new Error(`package is missing ${label} (${file})`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { throw new Error(`package ${label} is malformed: ${(e as Error).message}`); }
}

export function loadPackage(packageDir: string): LoadedPackage {
  const task = readJson(path.join(packageDir, "task.json"), "task.json") as {
    task_id?: string; fields?: Array<{ field_id?: string }>; agent_config?: AgentConfigEntry[];
  };
  const perf = readJson(path.join(packageDir, "performance.json"), "performance.json") as PerfReport;
  if (!task.task_id) throw new Error("package task.json has no task_id");
  const agentConfig = Array.isArray(task.agent_config) ? task.agent_config : [];
  if (agentConfig.length === 0) throw new Error("package task.json has no agent_config");
  const fieldIds = (task.fields ?? []).map((f) => f.field_id!).filter(Boolean);
  return {
    taskId: task.task_id,
    fieldIds,
    agentConfig,
    performance: { agents: Array.isArray(perf?.agents) ? perf.agents : [] },
  };
}
```

- [ ] **Step 5: Run → PASS + typecheck**
Run: `npx vitest run packages/deploy-runner/src/load-package.test.ts` → 3 pass.
Run: `npm run typecheck` → no errors.

- [ ] **Step 6: Commit**
```bash
cd <repo>
git add chart-review-platform-light/packages/deploy-runner/package.json chart-review-platform-light/packages/deploy-runner/src/load-package.ts chart-review-platform-light/packages/deploy-runner/src/load-package.test.ts
git commit -m "feat(light): deploy-runner package + loadPackage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `selectAgent`

**Files:**
- Create: `packages/deploy-runner/src/select-agent.ts`
- Test: `packages/deploy-runner/src/select-agent.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// packages/deploy-runner/src/select-agent.test.ts
import { describe, it, expect } from "vitest";
import { selectAgent } from "./select-agent.js";

const cfg = [
  { id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default" },
  { id: "agent_2", search_mode_preset: "smart-search", interpretation_preset: "skeptical" },
];

describe("selectAgent", () => {
  it("picks the highest avg_accuracy", () => {
    const r = selectAgent(cfg, { agents: [
      { agent_id: "agent_1", avg_accuracy: 0.7 }, { agent_id: "agent_2", avg_accuracy: 0.9 }] });
    expect(r.spec.id).toBe("agent_2");
    expect(r.reason).toMatch(/avg_accuracy/);
  });

  it("honors an explicit override", () => {
    const r = selectAgent(cfg, { agents: [
      { agent_id: "agent_1", avg_accuracy: 0.9 }, { agent_id: "agent_2", avg_accuracy: 0.1 }] }, "agent_2");
    expect(r.spec.id).toBe("agent_2");
    expect(r.reason).toMatch(/override/);
  });

  it("falls back to agent_1 on a tie", () => {
    const r = selectAgent(cfg, { agents: [
      { agent_id: "agent_1", avg_accuracy: 0.8 }, { agent_id: "agent_2", avg_accuracy: 0.8 }] });
    expect(r.spec.id).toBe("agent_1");
    expect(r.reason).toMatch(/tie|default/i);
  });

  it("falls back to agent_1 when performance is missing/null", () => {
    const r = selectAgent(cfg, { agents: [] });
    expect(r.spec.id).toBe("agent_1");
  });

  it("throws when the override id is not in the package", () => {
    expect(() => selectAgent(cfg, { agents: [] }, "agent_9")).toThrow(/agent_9/);
  });
});
```

- [ ] **Step 2: Run → FAIL**
Run: `npx vitest run packages/deploy-runner/src/select-agent.test.ts`

- [ ] **Step 3: Implement `select-agent.ts`**
```ts
// packages/deploy-runner/src/select-agent.ts
import type { AgentSpec } from "@chart-review/agent-specs";
import type { AgentConfigEntry, PerfReport } from "./load-package.js";

export interface AgentChoice { spec: AgentSpec; reason: string; }

function toSpec(e: AgentConfigEntry): AgentSpec {
  // model is intentionally dropped — the deepagents sidecar resolves the model
  // from env, so a per-agent model has no effect. Role axes drive behavior.
  return {
    id: e.id,
    ...(e.search_mode_preset ? { search_mode_preset: e.search_mode_preset } : {}),
    ...(e.interpretation_preset ? { interpretation_preset: e.interpretation_preset } : {}),
    ...(e.role_prompt ? { role_prompt: e.role_prompt } : {}),
  };
}

export function selectAgent(
  agentConfig: AgentConfigEntry[],
  performance: PerfReport,
  overrideId?: string,
): AgentChoice {
  if (overrideId) {
    const e = agentConfig.find((a) => a.id === overrideId);
    if (!e) throw new Error(`--agent ${overrideId} is not in the package (have: ${agentConfig.map((a) => a.id).join(", ")})`);
    return { spec: toSpec(e), reason: `explicit --agent override (${overrideId})` };
  }
  const acc = new Map(performance.agents.map((a) => [a.agent_id, a.avg_accuracy]));
  let best: AgentConfigEntry | null = null;
  let bestAcc = -1;
  let tie = false;
  for (const e of agentConfig) {
    const a = acc.get(e.id);
    if (typeof a === "number") {
      if (a > bestAcc) { best = e; bestAcc = a; tie = false; }
      else if (a === bestAcc) { tie = true; }
    }
  }
  if (!best || tie) {
    const fallback = agentConfig.find((a) => a.id === "agent_1") ?? agentConfig[0];
    return {
      spec: toSpec(fallback),
      reason: best && tie
        ? `tie on avg_accuracy (${bestAcc}) → default ${fallback.id}`
        : `no usable performance → default ${fallback.id}`,
    };
  }
  return { spec: toSpec(best), reason: `highest avg_accuracy (${bestAcc}) → ${best.id}` };
}
```

- [ ] **Step 4: Run → PASS + typecheck**
Run: `npx vitest run packages/deploy-runner/src/select-agent.test.ts` → 5 pass; `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
cd <repo>
git add chart-review-platform-light/packages/deploy-runner/src/select-agent.ts chart-review-platform-light/packages/deploy-runner/src/select-agent.test.ts
git commit -m "feat(light): deploy-runner selectAgent (best/override/fallback)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `enumeratePatients`

**Files:**
- Create: `packages/deploy-runner/src/enumerate-patients.ts`
- Test: `packages/deploy-runner/src/enumerate-patients.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// packages/deploy-runner/src/enumerate-patients.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enumeratePatients } from "./enumerate-patients.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function patient(id: string, notes: string[]) {
  const nd = path.join(dir, id, "notes");
  fs.mkdirSync(nd, { recursive: true });
  for (const n of notes) fs.writeFileSync(path.join(nd, n), "x");
}

describe("enumeratePatients", () => {
  it("returns patient dirs that have notes/*.txt, sorted", () => {
    patient("p_b", ["a.txt"]);
    patient("p_a", ["x.txt", "y.txt"]);
    expect(enumeratePatients(dir)).toEqual(["p_a", "p_b"]);
  });

  it("skips dirs with an empty or missing notes folder", () => {
    patient("p_ok", ["a.txt"]);
    fs.mkdirSync(path.join(dir, "p_empty", "notes"), { recursive: true });
    fs.mkdirSync(path.join(dir, "p_nonotes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "stray.txt"), "x");
    expect(enumeratePatients(dir)).toEqual(["p_ok"]);
  });

  it("throws when the data dir does not exist", () => {
    expect(() => enumeratePatients(path.join(dir, "nope"))).toThrow(/data.dir/i);
  });
});
```

- [ ] **Step 2: Run → FAIL**
Run: `npx vitest run packages/deploy-runner/src/enumerate-patients.test.ts`

- [ ] **Step 3: Implement `enumerate-patients.ts`**
```ts
// packages/deploy-runner/src/enumerate-patients.ts
import fs from "node:fs";
import path from "node:path";

/** Patient ids in a cohort dir: subfolders whose notes/ holds ≥1 .txt file.
 *  Sorted for stable output. Throws if the dir doesn't exist. */
export function enumeratePatients(dataDir: string): string[] {
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error(`--data-dir does not exist or is not a directory: ${dataDir}`);
  }
  const out: string[] = [];
  for (const name of fs.readdirSync(dataDir)) {
    const notesDir = path.join(dataDir, name, "notes");
    if (!fs.existsSync(notesDir) || !fs.statSync(notesDir).isDirectory()) continue;
    const hasTxt = fs.readdirSync(notesDir).some((f) => f.endsWith(".txt"));
    if (hasTxt) out.push(name);
  }
  return out.sort();
}
```

- [ ] **Step 4: Run → PASS + typecheck**
Run: `npx vitest run packages/deploy-runner/src/enumerate-patients.test.ts` → 3 pass; `npm run typecheck` clean.

- [ ] **Step 5: Commit**
```bash
cd <repo>
git add chart-review-platform-light/packages/deploy-runner/src/enumerate-patients.ts chart-review-platform-light/packages/deploy-runner/src/enumerate-patients.test.ts
git commit -m "feat(light): deploy-runner enumeratePatients

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `env-model` + `collectResults`

**Files:**
- Create: `packages/deploy-runner/src/env-model.ts`
- Create: `packages/deploy-runner/src/collect-results.ts`
- Test: `packages/deploy-runner/src/collect-results.test.ts`

- [ ] **Step 1: Write `env-model.ts`** (mirrors the server's `/api/deepagents/model` logic):
```ts
// packages/deploy-runner/src/env-model.ts
/** Resolve the model the deepagents sidecar will actually use, from env. */
export function resolveEnvModel(env: NodeJS.ProcessEnv = process.env): { backend: string; model: string | null } {
  const backend = (env.DEEPAGENTS_LLM_BACKEND ?? "azure").toLowerCase();
  if (backend === "azure") return { backend, model: env.AZURE_OPENAI_DEPLOYMENT ?? null };
  if (backend === "vllm") return { backend, model: env.VLLM_MODEL ?? null };
  return { backend, model: null };
}
```

- [ ] **Step 2: Write the failing test for collectResults**
```ts
// packages/deploy-runner/src/collect-results.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectResults } from "./collect-results.js";

let root: string, out: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

// Write a fake promoted draft at the agentDraftPath location under `root`.
function draft(runId: string, pid: string, agentId: string, fas: unknown[]) {
  const d = path.join(root, "var", "runs", runId, "per_patient", pid, "agents");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${agentId}.json`), JSON.stringify({ field_assessments: fas }));
}

describe("collectResults", () => {
  it("writes per-patient json + csv + manifest; ok vs failed from status", () => {
    process.env.CHART_REVIEW_RUNS_ROOT = path.join(root, "var", "runs");
    const runId = "RUN1";
    draft(runId, "p_ok", "agent_1", [
      { field_id: "cancer_type", answer: "adenocarcinoma", confidence: "high", evidence: [] },
      { field_id: "disease_extent", answer: "no_info", confidence: "high", evidence: [] },
    ]);
    const status = {
      state: "complete_with_errors",
      per_patient: { p_ok: { state: "complete" }, p_fail: { state: "error", error: "boom" } },
      n_complete: 1, n_error: 1,
    } as any;
    const r = collectResults({
      runId, status, agentId: "agent_1", fieldIds: ["cancer_type", "disease_extent"],
      outDir: out, meta: { package_dir: "/pkg", task_id: "t1", agent_reason: "x",
        model: "gpt-4o", env_model: "gpt-4o", model_mismatch_warning: null, data_dir: "/dd" },
    });
    delete process.env.CHART_REVIEW_RUNS_ROOT;

    expect(r.n_ok).toBe(1);
    expect(r.n_failed).toBe(1);
    expect(r.failed_patient_ids).toEqual(["p_fail"]);
    // per-patient json for the ok patient
    const pj = JSON.parse(fs.readFileSync(path.join(out, "p_ok.json"), "utf8"));
    expect(pj.field_assessments).toHaveLength(2);
    // csv: header + one row (ok only)
    const csv = fs.readFileSync(path.join(out, "results.csv"), "utf8").trim().split("\n");
    expect(csv[0]).toBe("patient_id,cancer_type,disease_extent");
    expect(csv[1]).toBe("p_ok,adenocarcinoma,no_info");
    expect(csv).toHaveLength(2);
    // manifest
    const man = JSON.parse(fs.readFileSync(path.join(out, "run_manifest.json"), "utf8"));
    expect(man.n_ok).toBe(1);
    expect(man.failed_patient_ids).toEqual(["p_fail"]);
    expect(man.agent_id).toBe("agent_1");
  });
});
```

- [ ] **Step 3: Run → FAIL**
Run: `npx vitest run packages/deploy-runner/src/collect-results.test.ts`

- [ ] **Step 4: Implement `collect-results.ts`**
```ts
// packages/deploy-runner/src/collect-results.ts
import fs from "node:fs";
import path from "node:path";
import { agentDraftPath, type RunStatus } from "@chart-review/infra-batch-run";

export interface CollectMeta {
  package_dir: string; task_id: string; agent_reason: string;
  model: string | null; env_model: string | null;
  model_mismatch_warning: string | null; data_dir: string;
}
export interface CollectArgs {
  runId: string; status: RunStatus; agentId: string;
  fieldIds: string[]; outDir: string; meta: CollectMeta;
}
export interface CollectResult { n_ok: number; n_failed: number; failed_patient_ids: string[]; }

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function collectResults(args: CollectArgs): CollectResult {
  const { runId, status, agentId, fieldIds, outDir, meta } = args;
  fs.mkdirSync(outDir, { recursive: true });

  const ok: string[] = [];
  const failed: string[] = [];
  const csvRows: string[] = [["patient_id", ...fieldIds].map(csvCell).join(",")];

  for (const [pid, ps] of Object.entries(status.per_patient)) {
    if (ps.state !== "complete") { failed.push(pid); continue; }
    let draft: { field_assessments?: Array<{ field_id: string; answer?: unknown }> };
    try { draft = JSON.parse(fs.readFileSync(agentDraftPath(runId, pid, agentId), "utf8")); }
    catch { failed.push(pid); continue; }
    const fas = draft.field_assessments ?? [];
    // per-patient json
    fs.writeFileSync(
      path.join(outDir, `${pid}.json`),
      JSON.stringify({ patient_id: pid, task_id: meta.task_id, agent_id: agentId, field_assessments: fas }, null, 2) + "\n",
    );
    // csv row
    const byField = new Map(fas.map((f) => [f.field_id, f.answer]));
    csvRows.push([pid, ...fieldIds.map((f) => byField.get(f))].map(csvCell).join(","));
    ok.push(pid);
  }

  fs.writeFileSync(path.join(outDir, "results.csv"), csvRows.join("\n") + "\n");
  fs.writeFileSync(
    path.join(outDir, "run_manifest.json"),
    JSON.stringify({
      ...meta, agent_id: agentId, run_id: runId,
      n_patients: ok.length + failed.length, n_ok: ok.length, n_failed: failed.length,
      ok_patient_ids: ok.sort(), failed_patient_ids: failed.sort(),
    }, null, 2) + "\n",
  );
  return { n_ok: ok.length, n_failed: failed.length, failed_patient_ids: failed.sort() };
}
```

- [ ] **Step 5: Run → PASS + typecheck**
Run: `npx vitest run packages/deploy-runner/src/collect-results.test.ts` → pass; `npm run typecheck` clean.
> Note: the test sets `CHART_REVIEW_RUNS_ROOT` so `agentDraftPath` resolves under the temp dir. Confirm `runsRoot()` honors `CHART_REVIEW_RUNS_ROOT` (it does — `runs.ts:133`). If `agentDraftPath` is computed from `PLATFORM_ROOT` instead, write the fixture draft at the path `agentDraftPath` actually returns (read it once and mkdir there).

- [ ] **Step 6: Commit**
```bash
cd <repo>
git add chart-review-platform-light/packages/deploy-runner/src/env-model.ts chart-review-platform-light/packages/deploy-runner/src/collect-results.ts chart-review-platform-light/packages/deploy-runner/src/collect-results.test.ts
git commit -m "feat(light): deploy-runner env-model + collectResults (json/csv/manifest)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: CLI entry + `deploy` script

**Files:**
- Create: `packages/deploy-runner/src/index.ts`
- Modify: `package.json` (root) — add `deploy` script

- [ ] **Step 1: Implement `index.ts`** (orchestration; uses `util.parseArgs`):
```ts
// packages/deploy-runner/src/index.ts
// Headless deployment runner. See docs/superpowers/specs/2026-06-07-deployment-runner-design.md
import { parseArgs } from "node:util";
import path from "node:path";
import { startBatchRun, getRunStatus } from "@chart-review/infra-batch-run";
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
```

- [ ] **Step 2: Add the root `deploy` script** — in `package.json` `scripts`, add:
```json
    "deploy": "tsx packages/deploy-runner/src/index.ts",
```
(Confirm `tsx` is available — it's used by `dev:server`. Reuse the same invocation style.)

- [ ] **Step 3: Typecheck + arg smoke**
Run: `npm run typecheck` → no errors.
Run: `npm run deploy` (no args) → prints the usage line and exits non-zero.

- [ ] **Step 4: Commit**
```bash
cd <repo>
git add chart-review-platform-light/packages/deploy-runner/src/index.ts chart-review-platform-light/package.json
git commit -m "feat(light): deploy-runner CLI entry + npm run deploy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification + README

**Files:**
- Modify: `README.md`
- (verification only otherwise)

- [ ] **Step 1: All unit gates green**
```bash
cd <repo>/chart-review-platform-light
npm run typecheck && npx vitest run --reporter=dot
```
Expected: typecheck 0; all tests pass (existing + the new deploy-runner unit tests).

- [ ] **Step 2: Build a tiny cohort from the existing corpus and run end-to-end** (needs `.env` configured for Azure gpt-4o + the Python sidecar, like a normal run):
```bash
cd <repo>/chart-review-platform-light
# assemble a 2-patient cohort in the expected layout
mkdir -p /tmp/deploy_cohort/patient_easy_nsclc_02/notes /tmp/deploy_cohort/patient_probable_fhx_01/notes
cp corpus/patients/patient_easy_nsclc_02/notes/*.txt /tmp/deploy_cohort/patient_easy_nsclc_02/notes/
cp corpus/patients/patient_probable_fhx_01/notes/*.txt /tmp/deploy_cohort/patient_probable_fhx_01/notes/
# pick an existing export package
PKG=$(ls -d var/exports/lung-cancer-phenotype-light/*/ | head -1)
npm run deploy -- --package "$PKG" --data-dir /tmp/deploy_cohort --out /tmp/deploy_out
```
Expected: logs the chosen agent + reason, runs both patients, prints `N ok`. Then:
```bash
ls /tmp/deploy_out                       # patient_*.json, results.csv, run_manifest.json
cat /tmp/deploy_out/results.csv          # header + one row per ok patient
cat /tmp/deploy_out/run_manifest.json    # agent_id, model, n_ok/n_failed
```
Confirm the per-patient JSON has `field_assessments` with cited evidence (offsets), proving the faithfulness path ran against the new cohort. Clean up: `rm -rf /tmp/deploy_cohort /tmp/deploy_out`.

- [ ] **Step 3: README** — add a "Deploy on a larger cohort" section to `README.md`:
````markdown
## Deploy on a larger cohort

After validating a session and exporting its package (PERFORMANCE → "Export
task package"), run the validated agent on a new cohort headlessly:

```sh
npm run deploy -- \
  --package var/exports/<task>/<exportId> \
  --data-dir /path/to/cohort \   # <patient_id>/notes/*.txt
  --out /path/to/results \
  [--agent agent_2]              # default: best agent by avg_accuracy
```

Outputs `<out>/<patient_id>.json` (answers + cited evidence), `results.csv`
(one row per patient), and `run_manifest.json`. Runs on this platform with the
task installed; uses the `.env`-configured model (warns if it differs from the
package's recorded model).
````

- [ ] **Step 4: Commit**
```bash
cd <repo>
git add chart-review-platform-light/README.md
git commit -m "docs(light): document the deploy runner (deploy on a larger cohort)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Run commands** from `chart-review-platform-light/`; git from the repo root `<repo>`.
- **Env propagation:** the CLI sets `process.env.CHART_REVIEW_PATIENTS_ROOT` *before* `startBatchRun`; the deepagents provider spawns the sidecar with `{ ...process.env }`, so the MCP subprocess reads notes from `--data-dir`. Don't move the assignment after `startBatchRun`.
- **Model is env-driven:** `selectAgent` deliberately drops the per-agent `model` (the sidecar ignores it). The package's recorded model is used only for the mismatch warning.
- **Single agent only** (v1): always pass exactly one spec to `agent_specs`.
- **Failed patients** (B1 loud-fail): a patient with `per_patient.state==="error"` produced no draft — omit from the CSV, list in the manifest. The CLI exits non-zero only if every patient failed.
- **Same-platform constraint:** the task/skill (`pkg.taskId`) must be installed; `startBatchRun` throws "task not found" otherwise — surface that error clearly.
