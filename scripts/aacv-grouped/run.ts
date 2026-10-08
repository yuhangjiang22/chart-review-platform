// AACV grouped run — one pass per retrieval group, then merge.
//
// WHY: handed all 38 criteria at once the agent front-loads a few keyword
// searches and then writes every answer without looking anything else up, so
// criteria late in the list are answered from material never searched for.
// Scoping each pass to one group forces retrieval to serve those criteria.
// Measured on patient_real_adrd_007: 0/6 DLB features decided with 38 in
// scope, 2/6 with 6 in scope, using fewer retrieval operations (8 vs 12).
//
// PRINTS NO PATIENT DATA — run status, group ids and answer labels only.
//
// Usage: node_modules/.bin/tsx scripts/aacv-grouped/run.ts <patient_id ...>
//   GROUPS=dlb,cognition   restrict to named groups (default: all nine)
//   RUN_MAX_TURNS=80       per-pass turn cap
//   RUN_DEADLINE_MIN=45    per-pass deadline

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(ROOT, ".env") });
process.env.CHART_REVIEW_PLATFORM_ROOT ??= ROOT;

const patients = process.argv.slice(2);
if (!patients.length) { console.error("[grouped] FATAL: name the patients explicitly"); process.exit(1); }
if (!process.env.CHART_REVIEW_PHI_MODEL) {
  console.error("[grouped] FATAL: CHART_REVIEW_PHI_MODEL unset — a phi patient must route to a HIPAA-eligible model.");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "groups.json"), "utf8"));
const only = (process.env.GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const groups = only.length ? manifest.groups.filter((g: any) => only.includes(g.id)) : manifest.groups;
if (!groups.length) { console.error(`[grouped] FATAL: no groups matched ${JSON.stringify(only)}`); process.exit(1); }

const batch = await import("@chart-review/infra-batch-run");
const { startBatchRun, getRunStatus, draftPath } = batch as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["complete", "complete_with_errors", "failed", "error"]);

async function runGroup(pid: string, g: any): Promise<{ run_id: string; ok: boolean }> {
  const { run_id } = startBatchRun({
    task_id: manifest.task_id,
    patient_ids: [pid],
    started_by: "aacv-grouped",
    label: `group:${g.id}`,
    max_concurrency: 1,
    max_turns_per_patient: Number(process.env.RUN_MAX_TURNS ?? 80),
    target_field_ids: g.fields,
  });
  const deadline = Date.now() + Number(process.env.RUN_DEADLINE_MIN ?? 45) * 60 * 1000;
  for (;;) {
    await sleep(5000);
    const st = getRunStatus(run_id);
    if (st && TERMINAL.has(st.state)) return { run_id, ok: st.state.startsWith("complete") };
    if (Date.now() > deadline) { console.error(`[grouped]   ${g.id}: deadline exceeded`); return { run_id, ok: false }; }
  }
}

let exitCode = 0;
for (const pid of patients) {
  console.log(`\n[grouped] ===== ${pid} — ${groups.length} group(s) =====`);
  // Start from any existing merged draft so a partial run (GROUPS=...) tops up
  // rather than replaces. Overwriting cost a full 38-criterion draft once.
  const dir0 = path.join(ROOT, "var", "aacv-grouped", pid);
  const prior = path.join(dir0, "merged_draft.json");
  const base = fs.existsSync(prior) ? JSON.parse(fs.readFileSync(prior, "utf8")) : null;
  const scoped = new Set(groups.flatMap((g: any) => g.fields));
  const merged: any[] = base ? (base.field_assessments ?? []).filter((a: any) => !scoped.has(a.field_id)) : [];
  const seen = new Set<string>(merged.map((a: any) => a.field_id));
  const provenance: Record<string, string> = base?.merged_from ? { ...base.merged_from } : {};
  if (base) console.log(`[grouped]   carrying forward ${merged.length} answer(s) from the existing draft`);
  const alerts: any[] = [];   // kept, not discarded — a scoped pass can only see within-group
                              // relationships, so cross-GROUP alerts are a known blind spot of this mode

  for (const g of groups) {
    process.stdout.write(`[grouped]   ${g.id} (${g.fields.length} criteria) ... `);
    const { run_id, ok } = await runGroup(pid, g);
    const dp = draftPath(run_id, pid);
    if (!ok || !fs.existsSync(dp)) { console.log(`FAILED (run ${run_id})`); exitCode = 2; continue; }
    const d = JSON.parse(fs.readFileSync(dp, "utf8"));
    const got = (d.field_assessments ?? []).filter((a: any) => g.fields.includes(a.field_id));
    const stray = (d.field_assessments ?? []).length - got.length;
    for (const a of got) {
      if (seen.has(a.field_id)) continue;      // first pass to answer a field wins
      seen.add(a.field_id); merged.push(a); provenance[a.field_id] = run_id;
    }
    for (const al of (d.cross_criterion_alerts ?? [])) alerts.push({ ...al, from_group: g.id, run_id });
    const missing = g.fields.filter((f: string) => !got.some((a: any) => a.field_id === f));
    console.log(`${got.length}/${g.fields.length}${missing.length ? ` MISSING:${missing.join(",")}` : ""}${stray ? ` (+${stray} out-of-scope ignored)` : ""}`);
  }

  const all = manifest.groups.flatMap((g: any) => g.fields);   // completeness is judged against ALL 38
  const absent = all.filter((f: string) => !seen.has(f));
  const out = {
    schema_version: "1.0", task_id: manifest.task_id, patient_id: pid,
    review_status: absent.length ? "in_progress" : "agent_complete",
    updated_by: "aacv-grouped", updated_at: new Date().toISOString(),
    field_assessments: merged.sort((a, b) => a.field_id.localeCompare(b.field_id)),
    cross_criterion_alerts: alerts,
    cross_group_alerts_not_evaluated: true,
    merged_from: provenance,
  };
  const dir = path.join(ROOT, "var", "aacv-grouped", pid);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "merged_draft.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

  const counts = merged.reduce((m: any, a: any) => (m[a.answer] = (m[a.answer] ?? 0) + 1, m), {});
  console.log(`[grouped]   merged ${merged.length}/${all.length} criteria -> ${path.relative(ROOT, outPath)}`);
  console.log(`[grouped]   answers: ${JSON.stringify(counts)}`);
  if (absent.length) { console.log(`[grouped]   INCOMPLETE — never answered: ${absent.join(",")}`); exitCode = 2; }
}
process.exit(exitCode);
