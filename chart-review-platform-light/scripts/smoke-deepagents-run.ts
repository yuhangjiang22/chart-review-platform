// End-to-end smoke (Task G3): run the deepagents provider against ONE
// patient with the lung-cancer-phenotype-light task, mirroring the
// phenotype path in infra-batch-run/runs.ts. Validates the full chain:
// DeepAgentsProvider -> Python sidecar -> stdio MCP server -> gpt-4o ->
// set_field_assessment (faithfulness gate) -> review_state.json.
//
// Run:  set -a; source .env; set +a; npx tsx scripts/smoke-deepagents-run.ts [patientId]
import fs from "node:fs";
import path from "node:path";
import { runAgent } from "@chart-review/agent-provider";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import { loadCompiledTask } from "@chart-review/tasks";
import { guidelineDir } from "@chart-review/rubric";
import { patientDir } from "@chart-review/patients";

const patientId = process.argv[2] ?? "patient_easy_nsclc_01";
const taskId = "lung-cancer-phenotype-light";
const sessionId = "smoke-g3";

const task = loadCompiledTask(taskId);
if (!task) throw new Error(`task ${taskId} not found`);

const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT!;
const scratchRoot = path.join(platformRoot, "var", "tmp", `smoke-g3-${patientId}`);
fs.rmSync(scratchRoot, { recursive: true, force: true });
fs.mkdirSync(scratchRoot, { recursive: true });

const prompt = [
  `You are reviewing one patient's clinical notes for the lung-cancer-phenotype-light task.`,
  `Active patient: ${patientId}`,
  ``,
  `Steps:`,
  `1. Call list_notes, then read_notes to read all of this patient's notes.`,
  `2. Call list_criteria, then read_criteria(["cancer_type","disease_extent"]) for the allowed answer values + guidance.`,
  `3. For EACH of the two fields, call set_field_assessment(field_id, answer, confidence, evidence, rationale).`,
  `   - answer MUST be one of that field's enum values.`,
  `   - evidence MUST quote verbatim note text (with note_id) so faithfulness passes.`,
  `4. Emit a one-line summary and stop.`,
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
  const setFieldCalls: unknown[] = [];
  for await (const event of runAgent({
    prompt,
    cwd: patientDir(patientId),
    patientId,
    taskId,
    guidelinePath: guidelineDir(taskId),
    mcpServers,
    maxTurns: 24,
    permissionMode: "acceptEdits",
    provider: "deepagents",
    extraSystemPrompt: extraSystem,
  } as any)) {
    if (event.type === "tool_use") {
      toolCalls++;
      console.log(`  [tool_use] ${event.tool_name}`);
      if (event.tool_name?.includes("set_field_assessment")) {
        setFieldCalls.push(event.tool_input);
        const inp: any = event.tool_input;
        console.log(`      -> field=${inp?.field_id} answer=${JSON.stringify(inp?.answer)}`);
      }
    } else if (event.type === "tool_result") {
      const out = (event as any).output;
      const s = typeof out === "string" ? out : JSON.stringify(out);
      if (s && /error|reject|faithful|mismatch|invalid|not found/i.test(s)) {
        console.log(`      [tool_result!] ${s.slice(0, 300)}`);
      }
    } else if (event.type === "text") {
      const t = (event as any).text?.slice(0, 200);
      if (t) console.log(`  [text] ${t}`);
    } else if (event.type === "error") {
      console.log(`  [ERROR] ${(event as any).error}`);
    } else if (event.type === "result") {
      console.log(`  [result] ${(event as any).result?.slice(0, 200) ?? ""}`);
    }
  }

  console.log(`\nTotal tool calls: ${toolCalls}; set_field_assessment calls: ${setFieldCalls.length}`);

  const reviewStatePath = path.join(scratchRoot, patientId, taskId, "review_state.json");
  if (!fs.existsSync(reviewStatePath)) {
    console.log(`\nFAIL: no review_state.json at ${reviewStatePath}`);
    process.exit(1);
  }
  const rs = JSON.parse(fs.readFileSync(reviewStatePath, "utf8"));
  console.log(`\nreview_state.json field_assessments:`);
  for (const fa of rs.field_assessments ?? []) {
    console.log(`  - ${fa.field_id} = ${JSON.stringify(fa.answer)} (conf=${fa.confidence}); evidence=${(fa.evidence ?? []).length} quote(s)`);
  }
  const ids = (rs.field_assessments ?? []).map((f: any) => f.field_id).sort();
  const ok = JSON.stringify(ids) === JSON.stringify(["cancer_type", "disease_extent"]);
  console.log(`\n${ok ? "PASS" : "PARTIAL"}: ${ids.length}/2 fields committed (faithfulness gate enforced by MCP).`);
  process.exit(ok ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
