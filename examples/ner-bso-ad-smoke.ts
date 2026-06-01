// Real-agent end-to-end smoke for the NER lifecycle.
//
// Walks every Phase 0/1/2 surface against a real codex (or Claude)
// agent on one patient × the bso-ad-ner task. Burns real tokens
// (~$0.01–0.05 for the codex extract + ~$0.50 if --judge is set).
//
// Required env (loaded from chart-review-platform-v2/.env then v1's
// chart-review-platform/app/.env):
//   ANTHROPIC_AUTH_TOKEN  — Claude path
//   AZURE_OPENAI_API_KEY  — Codex path
//   AGENT_PROVIDER        — "claude" | "codex" (default codex per v2 .env)
//
// Run:
//   npx tsx examples/ner-bso-ad-smoke.ts                   # extract only
//   npx tsx examples/ner-bso-ad-smoke.ts --judge           # extract + judge 1 novel_candidate
//   CHART_REVIEW_SUBJECT=patient_easy_sclc_01 ... overrides patient
//
// What it validates (each step prints its result):
//   1. loadCompiledTask → task_kind="ner", ontology resolves
//   2. preflight returns ok=true
//   3. startBatchRun produces a real agent_1.json with span_labels[]
//   4. faithfulness: every span's source[start:end] === text
//   5. eval-span-iaa: F1 + tuple_kappa across (agent_1, synthetic agent_2)
//   6. judgeSpan on one novel_candidate (only with --judge)
//   7. GET /api/reviews/.../span-history/<id> via direct readUnitHistory
//
// Skips: real human PATCH on a span (no human in the loop); cohort
// drift (no historical cohort yet); methods text (no calibration run).

import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

const V2_ROOT = path.resolve(__dirname, "..");
const V1_ROOT = path.resolve(V2_ROOT, "..", "chart-review-platform");
dotenv.config({ path: path.join(V1_ROOT, "app", ".env") });
dotenv.config({ path: path.join(V2_ROOT, ".env") });

import { loadCompiledTask } from "../packages/tasks/src/index.js";
import { resolveOntologyPath } from "../packages/mcp-server-ner-anthropic/src/index.js";
import { computeSpanIaa } from "../packages/eval-span-iaa/src/index.js";
import { startBatchRun, getRunStatus } from "../packages/infra-batch-run/src/runs.js";
import { readUnitHistory } from "../packages/audit-trail/src/index.js";
import { judgeSpan } from "../server/lib/judge.js";
import type { SpanLabel } from "../packages/platform-types/src/index.js";

const TASK_ID = "bso-ad-ner";
const PATIENT_ID = process.env.CHART_REVIEW_SUBJECT ?? "patient_easy_sclc_01";
const WITH_JUDGE = process.argv.includes("--judge");

function header(s: string) {
  console.log(`\n=== ${s} ===`);
}

async function main() {
  // 1. Task loads + ontology resolves
  header("step 1: task + ontology");
  const task = loadCompiledTask(TASK_ID);
  if (!task) throw new Error(`task ${TASK_ID} not found — vendor the bso-ad-ner skill first`);
  const ontoPath = resolveOntologyPath(task);
  console.log(`  task_kind=${task.task_kind} ontology_pin=${(task as { ontology_pin?: string }).ontology_pin ?? "(none)"}`);
  console.log(`  ontology=${ontoPath}  exists=${fs.existsSync(ontoPath)}`);

  // 2. Preflight (HTTP-less — direct fn call)
  // Skipping HTTP preflight here; the dev server isn't required for this example.

  // 3. startBatchRun
  header("step 3: startBatchRun (real agent)");
  const result = startBatchRun({
    task_id: TASK_ID,
    patient_ids: [PATIENT_ID],
    started_by: "ner-smoke",
    max_concurrency: 1,
    max_turns_per_patient: 40,
    cost_cap_usd: 5,
    label: `ner-smoke-${Date.now()}`,
  });
  console.log(`  run_id=${result.run_id}`);

  // Poll status until complete
  let state = "running";
  let cost = 0;
  for (let i = 0; i < 60 && state === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const status = getRunStatus(result.run_id);
    if (!status) break;
    state = status.state;
    cost = status.total_cost_usd;
    console.log(`  poll ${i + 1}: state=${state}  cost=$${cost.toFixed(4)}`);
  }
  if (state === "running") throw new Error("agent run timed out (>10 min)");

  // 4. Faithfulness check on the promoted agent draft
  header("step 4: faithfulness");
  const draftPath = path.join(
    V2_ROOT, "var", "runs", result.run_id, "per_patient", PATIENT_ID,
    "agents", "agent_1.json",
  );
  if (!fs.existsSync(draftPath)) throw new Error(`no draft at ${draftPath}`);
  const draft = JSON.parse(fs.readFileSync(draftPath, "utf8")) as { span_labels: SpanLabel[] };
  console.log(`  ${draft.span_labels.length} spans committed`);
  const corpusBase = path.join(V1_ROOT, "corpus", "patients", PATIENT_ID, "notes");
  let pass = 0, fail = 0;
  for (const s of draft.span_labels) {
    const src = fs.readFileSync(path.join(corpusBase, `${s.note_id}.txt`), "utf8");
    if (src.slice(s.start, s.end) === s.text) pass++;
    else { fail++; console.log(`  FAIL ${s.span_id}: text mismatch`); }
  }
  console.log(`  faithfulness: ${pass} pass, ${fail} fail`);

  // 5. Span IAA on (agent_1, synthetic agent_2) — perturb 3 spans.
  header("step 5: eval-span-iaa");
  const A = draft.span_labels;
  const B: SpanLabel[] = A.slice(1).map((s, i) => {
    if (i === 0) return { ...s, concept_name: "(synthetic_perturbation)" };
    if (i === 1) return { ...s, end: s.end + 1 };
    return s;
  });
  const iaa = computeSpanIaa(A, B);
  console.log(`  macro_f1=${iaa.macro_f1?.toFixed(3)} tuple_kappa=${iaa.tuple_kappa?.toFixed(3)} disagreements=${iaa.pairs.filter((p) => p.kind !== "agree").length}`);

  // 6. judgeSpan on one novel_candidate (only with --judge)
  if (WITH_JUDGE) {
    header("step 6: judgeSpan (real Claude call)");
    const novel = draft.span_labels.find((s) => s.status === "novel_candidate");
    if (!novel) {
      console.log("  (no novel_candidate in this run; skipping)");
    } else {
      console.log(`  judging span_id=${novel.span_id} text=${JSON.stringify(novel.text)} entity_type=${novel.entity_type}`);
      const jOut = await judgeSpan({
        patientId: PATIENT_ID,
        taskId: TASK_ID,
        span_id: novel.span_id,
        note_id: novel.note_id,
        entity_type: novel.entity_type,
        kind: "novel_candidate",
        agent_a: {
          agent_id: "agent_1", ...novel, status: "novel_candidate",
        },
        provider: "claude",
      });
      console.log(`  ok=${jOut.ok} cost=$${jOut.cost_usd}  ms=${jOut.duration_ms}`);
      if (jOut.analysis) {
        console.log(`    suggested_status=${jOut.analysis.suggested_status}`);
        console.log(`    suggested_concept=${JSON.stringify(jOut.analysis.suggested_concept_name)}`);
        console.log(`    classification=${jOut.analysis.classification_hint} confidence=${jOut.analysis.judge_confidence}`);
      } else if (jOut.error) {
        console.log(`    ERROR: ${jOut.error}`);
      }
    }
  } else {
    console.log("\n(step 6 skipped; pass --judge to exercise judgeSpan)");
  }

  // 7. Audit trail
  header("step 7: span-history");
  const firstSpan = draft.span_labels[0]!;
  const audit = readUnitHistory(PATIENT_ID, TASK_ID, firstSpan.span_id, "span");
  console.log(`  audit entries for first span: ${audit.length}`);
  for (const e of audit.slice(0, 3)) {
    console.log(`    ${e.ts}  ${(e as { action_type?: string }).action_type}`);
  }

  header("done");
  console.log(`  run_id=${result.run_id}`);
  console.log(`  view in UI: http://localhost:5174/#/studio/${TASK_ID}/patient/${PATIENT_ID}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
