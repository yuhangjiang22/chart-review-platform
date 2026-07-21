// QA end-to-end driver for the phenotype (cancer-diagnosis) flow against the
// running dev server. Uses global fetch (node 18+). Prints each step + status.
// Usage: node scripts/qa-phenotype-e2e.mjs <command> [args]
//   create-and-run   → make a 1-patient session + start a pilot; prints iter_id
//   poll <iter_id>   → poll the iter until terminal; prints final state
const B = "http://localhost:3002";
const T = "cancer-diagnosis";
const PID = process.env.QA_PID || "patient_fake_cancer_23";

async function login() {
  const r = await fetch(`${B}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewer_id: "yuhang" }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  return (await r.json()).token;
}
const H = (tok) => ({ Authorization: `Bearer ${tok}`, "Content-Type": "application/json" });

async function createAndRun() {
  const tok = await login();
  const sr = await fetch(`${B}/api/sessions/${T}`, {
    method: "POST", headers: H(tok),
    body: JSON.stringify({
      name: "qa-e2e-phenotype",
      patient_ids: [PID],
      agent_specs: [{ id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default" }],
    }),
  });
  const sj = await sr.json();
  const sid = sj.session?.session_id || sj.session_id;
  console.log(`session create: ${sr.status} session_id=${sid}`);
  if (!sid) { console.log("body:", JSON.stringify(sj).slice(0, 300)); process.exit(1); }

  const pr = await fetch(`${B}/api/pilots/${T}`, {
    method: "POST", headers: H(tok), body: JSON.stringify({ session_id: sid }),
  });
  const pj = await pr.json();
  const iter = pj.iter_id || pj.pilot?.iter_id;
  console.log(`pilot start: ${pr.status} iter_id=${iter}`);
  if (!iter) { console.log("body:", JSON.stringify(pj).slice(0, 300)); process.exit(1); }
  console.log(`SESSION=${sid}`);
  console.log(`ITER=${iter}`);
}

async function poll(iter) {
  const tok = await login();
  const deadline = Date.now() + 12 * 60 * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const r = await fetch(`${B}/api/pilots/${T}/${iter}`, { headers: H(tok) });
    const j = await r.json();
    const st = j.state || j.pilot?.state || "?";
    const ps = (j.patient_status || []).map((p) => `${p.patient_id}:${p.state ?? (p.agentDone ? "done" : "?")}`).join(",");
    const line = `state=${st} ${ps}`;
    if (line !== last) { console.log(`[poll] ${line}`); last = line; }
    if (["ready_to_validate", "complete", "failed", "abandoned", "error"].includes(st)) {
      console.log(`TERMINAL=${st}`);
      return;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  console.log("TIMEOUT");
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "create-and-run") await createAndRun();
else if (cmd === "poll") await poll(arg);
else { console.log("usage: create-and-run | poll <iter_id>"); process.exit(1); }
