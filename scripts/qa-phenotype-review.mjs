// QA smoke for the JUDGE + VALIDATE/review-commit phenotype functions.
// Usage: node scripts/qa-phenotype-review.mjs <session_id> <iter_id> <patient_id>
const B = "http://localhost:3002";
const T = "cancer-diagnosis";
const [SID, ITER, PID] = process.argv.slice(2);
if (!SID || !ITER || !PID) { console.log("usage: <session_id> <iter_id> <patient_id>"); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); ok ? pass++ : fail++; };

const tok = await (await fetch(`${B}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewer_id: "yuhang" }) })).json().then((j) => j.token);
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
const sq = `?session_id=${SID}`;

// 1. JUDGE — run LLM-as-judge pre-screen on the iter's drafts
{
  const r = await fetch(`${B}/api/pilots/${T}/${ITER}/judge`, { method: "POST", headers: H, body: "{}" });
  const j = await r.json().catch(() => null);
  check("judge run (POST)", r.status === 200, `status=${r.status} ${JSON.stringify(j).slice(0, 120)}`);
}
// 2. JUDGE status (GET)
{
  const r = await fetch(`${B}/api/pilots/${T}/${ITER}/judge`, { headers: H });
  check("judge status (GET)", r.status === 200, `status=${r.status}`);
}
// 3. derived-adjudications (GET) — the derived-field adjudication view
{
  const r = await fetch(`${B}/api/reviews/${PID}/${T}/derived-adjudications`, { headers: H });
  check("derived-adjudications (GET)", r.status === 200 || r.status === 404, `status=${r.status}`);
}
// 4. Commit a reviewer field assessment via /actions (copy the agent draft's answer)
{
  const draftsRes = await fetch(`${B}/api/pilots/${T}/${ITER}`, { headers: H });
  const dj = await draftsRes.json();
  // read the agent draft to copy an answer
  const runId = dj.manifest?.run_id;
  const dr = await fetch(`${B}/api/runs/${runId}/per_patient/${PID}/drafts`, { headers: H });
  const drafts = await dr.json().catch(() => null);
  const list = drafts?.drafts || drafts?.agents || (Array.isArray(drafts) ? drafts : []);
  const fa = list?.[0]?.field_assessments?.[0];
  if (!fa) { check("commit reviewer action", false, `no agent field to copy (drafts shape: ${JSON.stringify(drafts).slice(0,120)})`); }
  else {
    const body = { field_id: fa.field_id, answer: fa.answer, evidence: fa.evidence || [], rationale: "qa: accept agent", comment: "qa", status: "approved" };
    const r = await fetch(`${B}/api/reviews/${PID}/${T}/actions${sq}`, { method: "POST", headers: H, body: JSON.stringify(body) });
    const txt = r.ok ? "" : (await r.text()).slice(0, 160);
    check(`commit reviewer action (${fa.field_id})`, r.status === 200, `status=${r.status}${txt ? " " + txt : ""}`);
  }
}
// 5. Validate the patient (mark reviewer_validated)
{
  const r = await fetch(`${B}/api/reviews/${PID}/${T}/validate${sq}`, { method: "POST", headers: H });
  const txt = r.ok ? "" : (await r.text()).slice(0, 160);
  check("validate patient (POST)", r.status === 200 || r.status === 409, `status=${r.status}${txt ? " " + txt : ""}`);
}

console.log(`\n=== review smoke: ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 2 : 0);
