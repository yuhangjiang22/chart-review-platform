// End-to-end driver for chart-review-lung-cancer-adherence on the fake patient,
// via OpenRouter (agent_spec model = claude-sonnet → models.json vllm/OpenRouter).
// Usage:
//   node scripts/qa-lung-adherence-e2e.mjs run     → create session + start pilot
//   node scripts/qa-lung-adherence-e2e.mjs poll <iter>
//   node scripts/qa-lung-adherence-e2e.mjs result <iter> <patient>
const B = "http://localhost:3002";
const T = "lung-cancer-adherence";
const PID = "patient_fake_cancer_18";
const MODEL = process.env.QA_MODEL || "claude-sonnet";

const login = async () => (await (await fetch(`${B}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewer_id: "yuhang" }) })).json()).token;
const H = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

async function run() {
  const tok = await login(); const h = H(tok);
  const sr = await fetch(`${B}/api/sessions/${T}`, { method: "POST", headers: h, body: JSON.stringify({
    name: "qa-lung-e2e", patient_ids: [PID],
    agent_specs: [{ id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default", model: MODEL }],
  }) });
  const sj = await sr.json(); const sid = sj.session?.session_id || sj.session_id;
  console.log(`session create: ${sr.status} session=${sid}`);
  if (!sid) { console.log(JSON.stringify(sj).slice(0, 300)); process.exit(1); }
  const pr = await fetch(`${B}/api/pilots/${T}`, { method: "POST", headers: h, body: JSON.stringify({ session_id: sid }) });
  const pj = await pr.json(); const iter = pj.iter_id || pj.pilot?.iter_id;
  console.log(`pilot start: ${pr.status} iter=${iter} model=${MODEL}`);
  console.log(`SESSION=${sid}`); console.log(`ITER=${iter}`);
}

async function poll(iter) {
  const tok = await login(); const h = H(tok);
  const deadline = Date.now() + 15 * 60 * 1000; let last = "";
  while (Date.now() < deadline) {
    const j = await (await fetch(`${B}/api/pilots/${T}/${iter}`, { headers: h })).json();
    const st = j.manifest?.state ?? "?";
    const ps = (j.patient_status || []).map((p) => `${p.patient_id}:${p.agent_done ? "done" : p.errored ? "ERR" : p.agent_running ? "run" : "?"}`).join(",");
    const line = `state=${st} ${ps}`;
    if (line !== last) { console.log(`[poll] ${line}`); last = line; }
    const done = (j.patient_status || []).every((p) => p.agent_done || p.errored);
    if (["ready_to_validate", "complete", "failed", "abandoned", "error"].includes(st) || (j.patient_status?.length && done)) {
      console.log(`TERMINAL state=${st}`); return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("TIMEOUT");
}

async function result(iter, patient = PID) {
  const tok = await login(); const h = H(tok);
  const j = await (await fetch(`${B}/api/pilots/${T}/${iter}`, { headers: h })).json();
  const runId = j.manifest?.run_id;
  // Adherence drafts carry question_answers + rule_verdicts. The multi-agent
  // list endpoint (/per_patient/:pid/drafts) projects to field_assessments
  // ONLY (phenotype shape), so it returns empty for adherence. Read the full
  // single-agent draft (/patients/:pid/draft → readRunDraft) which preserves
  // question_answers and rule_verdicts.
  const dr = await fetch(`${B}/api/runs/${runId}/patients/${patient}/draft`, { headers: h });
  const d = await dr.json().catch(() => ({}));
  console.log("=== agent question answers ===");
  for (const a of (d.question_answers || [])) console.log(`  ${a.question_id} = ${JSON.stringify(a.answer)}  (${(a.evidence || []).length} ev)`);
  console.log("=== agent rule verdicts ===");
  for (const v of (d.rule_verdicts || [])) console.log(`  ${v.rule_id}: ${v.verdict}${v.attribution ? " / " + v.attribution : ""}`);
  if (!(d.question_answers || []).length) console.log("  (draft shape:", JSON.stringify(d).slice(0, 300), ")");
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "run") await run();
else if (cmd === "poll") await poll(a);
else if (cmd === "result") await result(a, b);
else console.log("usage: run | poll <iter> | result <iter> [patient]");
