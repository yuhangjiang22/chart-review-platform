// QA mutating-endpoint smoke for phenotype. Exercises the write paths with
// idempotent round-trips (read → write-same → verify) so it never corrupts the
// live rubric, plus session-scoped fork edit, version switch, and export.
// Usage: node scripts/qa/qa-phenotype-mutate.mjs <session_id> <iter_id>
const B = "http://localhost:3002";
const T = "cancer-diagnosis";
const [SID, ITER] = process.argv.slice(2);
if (!SID || !ITER) { console.log("usage: <session_id> <iter_id>"); process.exit(1); }

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
}

const tok = await (async () => {
  const r = await fetch(`${B}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewer_id: "yuhang" }) });
  return (await r.json()).token;
})();
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
const getJson = async (u) => { const r = await fetch(`${B}${u}`, { headers: H }); return { status: r.status, body: await r.json().catch(() => null) }; };

// 1. Overview round-trip (read → PUT same → verify unchanged)
{
  const { body: rub } = await getJson(`/api/tasks/${T}/rubric?session_id=${SID}`);
  const overview = rub?.overview_prose ?? rub?.overview ?? "";
  const put = await fetch(`${B}/api/tasks/${T}/overview`, { method: "PUT", headers: H, body: JSON.stringify({ overview_prose: overview }) });
  const { body: after } = await getJson(`/api/tasks/${T}/rubric?session_id=${SID}`);
  const unchanged = (after?.overview_prose ?? after?.overview ?? "") === overview;
  check("overview PUT round-trip", put.status === 200 && unchanged, `status=${put.status} unchanged=${unchanged}`);
}

// 2. Session-scoped criterion fork edit (PUT a field's guidance with ?session_id, write same)
{
  const { body: rub } = await getJson(`/api/tasks/${T}/rubric?session_id=${SID}`);
  const fields = rub?.fields || rub?.criteria || [];
  const fid = (f) => f.field_id || f.id;
  const leaf = fields.find((f) => !f.derivation && (f.extraction_guidance != null || f.prompt != null));
  if (!leaf) { check("criterion session-fork edit", false, "no editable leaf field found"); }
  else {
    // PUT the field's current values back (idempotent) to exercise the session-
    // scoped fork write without changing the rubric content.
    const payload = {
      prompt: leaf.prompt,
      definition: leaf.definition,
      extraction_guidance: leaf.extraction_guidance ?? "",
      enum: leaf.enum,
      examples: leaf.examples,
    };
    const put = await fetch(`${B}/api/tasks/${T}/criteria/${encodeURIComponent(fid(leaf))}?session_id=${SID}`, { method: "PUT", headers: H, body: JSON.stringify(payload) });
    const txt = put.ok ? "" : (await put.text()).slice(0, 160);
    check(`criterion session-fork edit (${fid(leaf)})`, put.status === 200, `status=${put.status}${txt ? " " + txt : ""}`);
  }
}

// 3. Rubric version switch (switch to active → no-op-safe) + list
{
  const { status, body } = await getJson(`/api/rubric/${T}/sessions/${SID}/versions`);
  const versions = Array.isArray(body?.versions) ? body.versions : [];
  check("versions list", status === 200 && versions.length >= 1, `status=${status} n=${versions.length}`);
  const active = body?.active;
  if (active) {
    const sw = await fetch(`${B}/api/rubric/${T}/sessions/${SID}/switch`, { method: "POST", headers: H, body: JSON.stringify({ version: active }) });
    check("version switch (to active, idempotent)", sw.status === 200, `status=${sw.status}`);
  } else check("version switch", false, "no active version");
}

// 4. Export the session package
{
  const r = await fetch(`${B}/api/export/${T}?session_id=${SID}`, { method: "POST", headers: H, body: "{}" });
  const j = await r.json().catch(() => null);
  const dir = j?.export_dir || j?.dir || j?.path || j?.out_dir;
  check("export session package", r.status === 200, `status=${r.status} dir=${dir ?? JSON.stringify(j).slice(0,120)}`);
}

// 5. Refine candidates (read) — already smoke-tested GET, assert shape here
{
  const { status, body } = await getJson(`/api/refine/${T}/${ITER}/candidates?session_id=${SID}`);
  const clusters = body?.clusters || body?.candidates || [];
  check("refine candidates shape", status === 200 && Array.isArray(clusters) , `status=${status} clusters=${Array.isArray(clusters)?clusters.length:"?"}`);
}

console.log(`\n=== mutate smoke: ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 2 : 0);
