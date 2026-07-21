// LLM-refinement demo for lung-cancer-adherence on a SYNTHETIC patient
// (patient_lung_demo_02, non-PHI → refine LLM = claude-sonnet via OpenRouter).
// Subcommands: run | poll <iter> | validate <sid> <iter> | refine <sid> <iter>
import fs from "node:fs";
const B = "http://localhost:3002";
const T = "lung-cancer-adherence";
const PID = "patient_lung_demo_02";
const DISAGREE = { MT5: "same_date" }; // reviewer differs from the agent here

const login = async () => (await (await fetch(`${B}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewer_id: "yuhang" }) })).json()).token;
const H = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const J = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };

async function agentDraft(h, iter) {
  // The adherence draft (question_answers + rule_verdicts) lives in agent_draft.json
  // on disk; the /drafts API returns phenotype-shaped field_assessments (empty here).
  const it = await J(await fetch(`${B}/api/pilots/${T}/${iter}`, { headers: h }));
  const runId = it.manifest?.run_id;
  const p = `var/runs/${runId}/per_patient/${PID}/agent_draft.json`;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
}

async function run() {
  const tok = await login(); const h = H(tok);
  const sr = await J(await fetch(`${B}/api/sessions/${T}`, { method: "POST", headers: h, body: JSON.stringify({
    name: "lung-refine-demo", patient_ids: [PID],
    agent_specs: [{ id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default", model: "claude-sonnet" }],
  }) }));
  const sid = sr.session?.session_id || sr.session_id;
  const pr = await J(await fetch(`${B}/api/pilots/${T}`, { method: "POST", headers: h, body: JSON.stringify({ session_id: sid }) }));
  const iter = pr.iter_id || pr.pilot?.iter_id;
  console.log(`SESSION=${sid}`); console.log(`ITER=${iter}`);
}

async function poll(iter) {
  const h = H(await login());
  const deadline = Date.now() + 15 * 60 * 1000; let last = "";
  while (Date.now() < deadline) {
    const j = await J(await fetch(`${B}/api/pilots/${T}/${iter}`, { headers: h }));
    const st = j.manifest?.state ?? "?";
    const done = (j.patient_status || []).every((p) => p.agent_done || p.errored);
    const line = `state=${st}`;
    if (line !== last) { console.log(`[poll] ${line}`); last = line; }
    if (["ready_to_validate", "complete", "failed", "error"].includes(st) || (j.patient_status?.length && done)) { console.log(`TERMINAL ${st}`); return; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("TIMEOUT");
}

async function validate(sid, iter) {
  const h = H(await login());
  const sq = `?session_id=${sid}`;
  const d = await agentDraft(h, iter);
  const qas = d.question_answers || [];
  const rvs = d.rule_verdicts || [];
  console.log(`agent answered ${qas.length} questions, ${rvs.length} verdicts`);
  // Commit reviewer answers — accept the agent's, except the injected disagreement.
  for (const a of qas) {
    const answer = DISAGREE[a.question_id] ?? a.answer;
    const r = await fetch(`${B}/api/reviews/${PID}/${T}/adherence/question-answer${sq}`, {
      method: "POST", headers: h, body: JSON.stringify({ question_id: a.question_id, answer }),
    });
    if (!r.ok) console.log(`  Q ${a.question_id} commit ${r.status}: ${(await r.text()).slice(0, 120)}`);
    else if (DISAGREE[a.question_id]) console.log(`  ${a.question_id}: reviewer=${answer} (agent=${a.answer}) ← DISAGREE`);
  }
  // Commit reviewer rule verdicts — accept the agent's (so the patient fully validates).
  for (const v of rvs) {
    const r = await fetch(`${B}/api/reviews/${PID}/${T}/adherence/rule-verdict${sq}`, {
      method: "POST", headers: h,
      body: JSON.stringify({ rule_id: v.rule_id, verdict: v.verdict, attribution: v.attribution ?? null, rationale: "demo: accept" }),
    });
    if (!r.ok) console.log(`  R ${v.rule_id} commit ${r.status}: ${(await r.text()).slice(0, 120)}`);
  }
  const st = await J(await fetch(`${B}/api/reviews/${PID}/${T}${sq}`, { headers: h }));
  console.log(`review_status=${st.review_status} validated_questions=${(st.validated_questions || []).length} validated_rules=${(st.validated_rules || []).length}`);
}

async function refine(sid, iter) {
  const h = H(await login());
  const sq = `?session_id=${sid}`;
  const base = `${B}/api/refine/${T}/${iter}`;
  const cands = await J(await fetch(`${base}/adherence-candidates${sq}`, { headers: h }));
  console.log("=== candidates ===");
  console.log("clusters:", (cands.clusters || []).map((c) => `${c.question_id}(${c.examples?.length ?? 0} ex)`).join(", ") || "(none)");
  console.log("=== analyze-errors (LLM attribution) ===");
  const ea = await J(await fetch(`${base}/adherence-analyze-errors${sq}`, { method: "POST", headers: h }));
  console.log("analyses:", (ea.analyses || []).map((a) => `${a.question_id}=${a.classification_hint}`).join(", ") || JSON.stringify(ea).slice(0, 200));
  console.log("=== propose (LLM refiner) for MT5 ===");
  const prop = await J(await fetch(`${base}/adherence-propose${sq}`, { method: "POST", headers: h, body: JSON.stringify({ question_id: "MT5" }) }));
  if (prop.proposed_guidance_addition) {
    console.log("gap_summary:", prop.gap_summary);
    console.log("proposed_guidance_addition:", prop.proposed_guidance_addition);
    console.log("classification:", prop.classification_hint, "| holdout:", JSON.stringify(prop.holdout), "| model:", prop.model);
    console.log("=== apply → new version ===");
    const ap = await J(await fetch(`${base}/adherence-apply${sq}`, {
      method: "POST", headers: h,
      body: JSON.stringify({ question_id: "MT5", proposed_guidance_addition: prop.proposed_guidance_addition, card: { examples: prop.examples, gap_summary: prop.gap_summary, rationale: prop.rationale, classification_hint: prop.classification_hint } }),
    }));
    console.log("apply:", JSON.stringify(ap).slice(0, 300));
  } else {
    console.log("propose result:", JSON.stringify(prop).slice(0, 400));
  }
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "run") await run();
else if (cmd === "poll") await poll(a);
else if (cmd === "validate") await validate(a, b);
else if (cmd === "refine") await refine(a, b);
else console.log("usage: run | poll <iter> | validate <sid> <iter> | refine <sid> <iter>");
