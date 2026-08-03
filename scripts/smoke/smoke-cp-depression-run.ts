// End-to-end smoke: run the deepagents provider against ONE patient with the
// cp-depression task, mirroring the phenotype path in infra-batch-run/runs.ts.
// Validates the full chain: DeepAgentsProvider -> Python sidecar -> stdio MCP
// server -> set_field_assessment (faithfulness gate) -> review_state.json, then
// scores the committed leaves against corpus ground_truth.json and computes the
// derived fields (study1_tier, phq9_threshold_met, final_decision) with the real
// contract-eval evaluator.
//
// Run:  set -a; source .env; set +a; npx tsx scripts/smoke/smoke-cp-depression-run.ts [patientId]
import fs from "node:fs";
import path from "node:path";
import { runAgent } from "@chart-review/agent-provider";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import { loadCompiledTask } from "@chart-review/tasks";
import { guidelineDir } from "@chart-review/rubric";
import { patientDir, readGroundTruth } from "@chart-review/patients";
import { evalDerivation } from "@chart-review/contract-eval";

const patientId = process.argv[2] ?? "patient_fake_cp_depression_01";
const taskId = "cp-depression";
const sessionId = "smoke-cp";
const LEAVES = ["high_confidence_diagnosis", "depressive_symptoms", "antidepressants", "psychiatry_referral", "phq9_severity_band"];
const DERIVED = ["study1_tier", "phq9_threshold_met", "final_decision"];

const task = loadCompiledTask(taskId);
if (!task) throw new Error(`task ${taskId} not found`);

const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT!;
const scratchRoot = path.join(platformRoot, "var", "tmp", `smoke-cp-${patientId}`);
fs.rmSync(scratchRoot, { recursive: true, force: true });
fs.mkdirSync(scratchRoot, { recursive: true });

const prompt = [
  `You are reviewing ONE patient's clinical notes for the cp-depression task.`,
  `Active patient: ${patientId}`,
  ``,
  `Follow the cp-depression skill procedure. In particular:`,
  `1. Call list_structured_data FIRST and record index_date. Only notes dated`,
  `   strictly AFTER index_date are in scope — drop any note dated on/before it.`,
  `2. list_criteria, then read_criteria for the five leaf fields.`,
  `3. Read every in-scope note; pin evidence per note with select_evidence.`,
  `4. Commit ONE answer for EACH of the five leaf fields via set_field_assessment`,
  `   (${LEAVES.join(", ")}) — answer MUST be an enum value; evidence MUST quote`,
  `   verbatim note text so faithfulness passes; cite EVERY supporting note.`,
  `5. Do NOT commit study1_tier, phq9_threshold_met, or final_decision (derived).`,
  `   Do NOT call set_review_status. Emit a one-line summary and stop.`,
].join("\n");

const extraSystem =
  "You are running unattended in batch mode. There is no human in the loop — " +
  "produce your draft and stop. Do not ask clarifying questions; pick the most " +
  "defensible answer with the evidence available.";

const mcpServers = buildMcpServersConfig(
  patientId, task, sessionId, { onStateUpdate: () => {} } as any,
  { reviewsRoot: scratchRoot, provider: "deepagents" },
);

async function main() {
  let toolCalls = 0;
  const setFieldCalls: any[] = [];
  for await (const event of runAgent({
    prompt,
    cwd: patientDir(patientId),
    patientId,
    taskId,
    guidelinePath: guidelineDir(taskId),
    mcpServers,
    maxTurns: 44,
    permissionMode: "acceptEdits",
    provider: "deepagents",
    extraSystemPrompt: extraSystem,
  } as any)) {
    if (event.type === "tool_use") {
      toolCalls++;
      const inp: any = (event as any).tool_input;
      if ((event as any).tool_name?.includes("set_field_assessment")) {
        setFieldCalls.push(inp);
        console.log(`  [set_field] ${inp?.field_id} = ${JSON.stringify(inp?.answer)}  (evidence: ${(inp?.evidence ?? []).length})`);
      } else {
        console.log(`  [tool] ${(event as any).tool_name}${inp?.field_id ? " " + inp.field_id : ""}`);
      }
    } else if (event.type === "tool_result") {
      const out = (event as any).output;
      const s = typeof out === "string" ? out : JSON.stringify(out);
      if (s && /error|reject|faithful|mismatch|invalid|unknown_field|not found/i.test(s)) {
        console.log(`      [tool_result!] ${s.slice(0, 260)}`);
      }
    } else if (event.type === "error") {
      console.log(`  [ERROR] ${(event as any).error}`);
    } else if (event.type === "result") {
      console.log(`  [result] ${(event as any).result?.slice(0, 160) ?? ""}`);
    }
  }

  console.log(`\nTotal tool calls: ${toolCalls}; set_field_assessment calls: ${setFieldCalls.length}`);

  const rsPath = path.join(scratchRoot, patientId, taskId, "review_state.json");
  if (!fs.existsSync(rsPath)) { console.log(`\nFAIL: no review_state.json at ${rsPath}`); process.exit(1); }
  const rs = JSON.parse(fs.readFileSync(rsPath, "utf8"));
  const answers: Record<string, any> = {};
  for (const fa of rs.field_assessments ?? []) answers[fa.field_id] = fa.answer;

  const gt = readGroundTruth(patientId);
  const gold = gt?.leaf_answers ?? {};
  console.log(`\n=== committed leaves vs gold ===`);
  let correct = 0;
  for (const id of LEAVES) {
    const got = answers[id];
    const exp = (gold as any)[id];
    const fa = (rs.field_assessments ?? []).find((f: any) => f.field_id === id);
    const mark = got === exp ? "✓" : (got === undefined ? "∅ MISSING" : "✗");
    if (got === exp) correct++;
    console.log(`  ${mark}  ${id.padEnd(28)} got=${JSON.stringify(got ?? null)}  gold=${JSON.stringify(exp ?? null)}  (ev=${(fa?.evidence ?? []).length})`);
  }

  console.log(`\n=== derived (computed from committed leaves via real evaluator) ===`);
  for (const id of DERIVED) {
    const val = evalDerivation(task as any, answers, id);
    const exp = (gt as any)?.derived_expected?.[id];
    const mark = exp === undefined ? " " : (val === exp ? "✓" : "✗");
    console.log(`  ${mark}  ${id.padEnd(20)} = ${JSON.stringify(val)}${exp !== undefined ? "  gold=" + JSON.stringify(exp) : ""}`);
  }

  console.log(`\n${correct}/${LEAVES.length} leaves match gold.`);
  process.exit(correct === LEAVES.length ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
