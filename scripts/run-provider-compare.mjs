// Run the same phenotype task on the same patient twice — once with
// AGENT_PROVIDER=claude, once with =codex — and dump each run's
// tool-call trace so we can compare what the two agents did.

import { startBatchRun, getRunStatus } from "@chart-review/infra-batch-run/runs";
import fs from "node:fs";
import path from "node:path";

const TASK = "lung-cancer-phenotype";
const PATIENT = "patient_fake_cancer_08";

async function runOnce(provider) {
  console.log(`\n══════ provider=${provider} ══════`);
  const { run_id, manifest } = startBatchRun({
    task_id: TASK,
    patient_ids: [PATIENT],
    started_by: `compare-${provider}`,
    label: `provider-compare-${provider}`,
    max_concurrency: 1,
    max_turns_per_patient: 40,
    cost_cap_usd: 5,
    provider,
    agent_specs: [{ id: "agent_1", role_preset: "default", role_version: "v1" }],
  });
  console.log(`run_id=${run_id}`);
  // Poll until done
  const t0 = Date.now();
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = getRunStatus(run_id);
    if (!s) continue;
    const pp = Object.values(s.per_patient)[0] || {};
    const dt = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`\r[${dt}s] state=${s.state} · pp=${pp.state}      `);
    if (["complete","complete_with_errors","aborted_cost_cap","failed"].includes(s.state)) {
      console.log();
      break;
    }
  }
  return run_id;
}

const claudeRun = await runOnce("claude");
const codexRun  = await runOnce("codex");

console.log("\n══════ summary ══════");
for (const [provider, runId] of [["claude", claudeRun], ["codex", codexRun]]) {
  const transcriptFp = path.join(
    "var/runs", runId, "per_patient", PATIENT, "agents", "agent_1_transcript.jsonl",
  );
  console.log(`\n─── ${provider} (${runId}) ───`);
  if (!fs.existsSync(transcriptFp)) { console.log("  (no transcript)"); continue; }
  const lines = fs.readFileSync(transcriptFp, "utf8").split("\n").filter(Boolean);
  let toolCalls = 0, textBlocks = 0;
  const toolHist = {};
  for (const ln of lines) {
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (e.type === "tool_use") {
      toolCalls++;
      const k = e.tool_name ?? "?";
      toolHist[k] = (toolHist[k] || 0) + 1;
    } else if (e.type === "text") {
      textBlocks++;
    } else if (e.type === "result") {
      const u = e.usage || {};
      console.log(`  cost: $${(e.cost_usd ?? 0).toFixed(4)} · turns: ${e.num_turns ?? "?"} · in=${u.input_tokens ?? "?"} cached=${u.cached_input_tokens ?? u.cache_read_input_tokens ?? "?"} out=${u.output_tokens ?? "?"}`);
    }
  }
  console.log(`  tool_use total: ${toolCalls}    text blocks: ${textBlocks}`);
  console.log(`  by tool: ${JSON.stringify(toolHist)}`);
  // First 20 tool_use events as a step-by-step
  console.log("  first 20 tool calls:");
  let count = 0;
  for (const ln of lines) {
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (e.type === "tool_use") {
      count++;
      if (count > 20) break;
      const args = JSON.stringify(e.tool_input ?? {}).slice(0, 110);
      console.log(`    ${count.toString().padStart(2)}. ${e.tool_name}  ${args}`);
    }
  }
}
