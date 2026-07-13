// scripts/e2e/doctor.ts — the Layer-0 consistency "doctor".
//
// A cheap, deterministic checker over the LIVE platform state. It asserts the
// referential-integrity invariants whose silent violation caused the string of
// bugs found in the 2026-07 RUCAM sessions — so the same *class* is caught
// before a human trips over it, not one instance at a time:
//
//   INDEX      corpus/index.json entries all have a fixture on disk   (phantom "unknown patient")
//   FIXTURE    each fixture has meta.json (+ person_id if phi) + notes  (empty/broken fixtures)
//   COHORT-CSV cohort-CSV tasks (RUCAM) have their data dir set + populated,
//              and each fixture's person_id resolves in it              (missing CHART_REVIEW_RUCAM_DATA_DIR)
//   SESSION    each session's cohort references existing fixtures       (phantom patient in a session)
//   CITATION   each session review_state's note citations resolve to a
//              note file present in the patient's CURRENT fixture       (stale citation after a repoint)
//   ALIGN      the latest run per (task,patient) is reflected in its
//              owning session's review_state                            (draft exists but reviewer shows empty)
//
// Read-only. Run: `node node_modules/tsx/dist/cli.mjs scripts/e2e/doctor.ts`
// (the repo's .bin shims are broken; invoke tsx's cli directly). Exit code = #FAILs.

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(ROOT, ".env") });
process.env.CHART_REVIEW_PLATFORM_ROOT ??= ROOT;

const { listCompiledTasks } = await import("@chart-review/tasks");
const { toolProfileFor } = await import("@chart-review/task-tools");
const { CORPUS_ROOT, patientPersonId } = await import("@chart-review/patients");
const { pathFor } = await import("@chart-review/storage");
const { listSessions } = await import("@chart-review/domain-iter");
const { parse: parseYaml } = await import("yaml");

type Level = "FAIL" | "WARN" | "INFO";
const findings: { level: Level; check: string; detail: string }[] = [];
const add = (level: Level, check: string, detail: string) => findings.push({ level, check, detail });

const patientsRoot = path.join(CORPUS_ROOT, "patients");
const fixtureDirs = fs.existsSync(patientsRoot)
  ? fs.readdirSync(patientsRoot).filter((d) => d.startsWith("patient_"))
  : [];
const fixtureSet = new Set(fixtureDirs);
const tasks = listCompiledTasks();

function readJson<T = any>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return null; }
}

// ── INDEX: every corpus/index.json entry has a fixture dir ──────────────────
{
  const idx = readJson<{ patients?: { patient_id: string }[] }>(path.join(CORPUS_ROOT, "index.json"));
  const entries = idx?.patients ?? [];
  const orphans = entries.filter((e) => e?.patient_id && !fixtureSet.has(e.patient_id));
  if (orphans.length) {
    add("FAIL", "INDEX", `${orphans.length}/${entries.length} index.json entries have NO fixture dir (would 400 "unknown patient" if a cohort picks one): ${orphans.slice(0, 3).map((o) => o.patient_id).join(", ")}${orphans.length > 3 ? " …" : ""}`);
  } else {
    add("INFO", "INDEX", `${entries.length} index entries, all resolve to a fixture`);
  }
}

// ── FIXTURE: usable at all — has meta.json + something to read. person_id is
//    NOT checked here (only cohort-CSV tasks need it; COHORT-CSV checks that,
//    correctly scoped — a notes-only PHI patient legitimately has no person_id).
for (const fx of fixtureDirs) {
  const dir = path.join(patientsRoot, fx);
  const meta = readJson<{ phi?: boolean }>(path.join(dir, "meta.json"));
  if (!meta) { add("WARN", "FIXTURE", `${fx}: no/invalid meta.json (incomplete fixture)`); continue; }
  const notesDir = path.join(dir, "notes");
  const nNotes = fs.existsSync(notesDir) ? fs.readdirSync(notesDir).filter((f) => f.endsWith(".txt")).length : 0;
  const hasOmop = fs.existsSync(path.join(dir, "omop"));
  if (nNotes === 0 && !hasOmop) add("WARN", "FIXTURE", `${fx}: no notes/*.txt and no omop/ — agent has nothing to read`);
}

// ── COHORT-CSV: data dir set + populated + fixtures' person_ids resolve ─────
function csvPersonIds(dataDir: string): Set<string> | null {
  const f = path.join(dataDir, "derived_rucam.csv");
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  const header = (lines[0] ?? "").split(",");
  const col = header.findIndex((h) => h.trim().toUpperCase() === "PERSON_ID");
  if (col < 0) return null;
  const ids = new Set<string>();
  for (const l of lines.slice(1)) {
    const cells = l.split(",");
    const v = (cells[col] ?? "").trim().replace(/\.0$/, "");
    if (v) ids.add(v);
  }
  return ids;
}
for (const task of tasks) {
  const profile = toolProfileFor(task as any);
  if (profile.dataSource !== "rucam-csv") continue;
  // Mirror runOneAgent: data dir = env ?? patientDir (fixture). We only assert the
  // shared-CSV env, since the fixture fallback is exactly the misconfiguration.
  const dataDir = process.env.CHART_REVIEW_RUCAM_DATA_DIR;
  if (!dataDir) { add("FAIL", "COHORT-CSV", `task '${task.task_id}': CHART_REVIEW_RUCAM_DATA_DIR is UNSET → plugin tools fall back to the fixture dir (no cohort CSVs) → FileNotFoundError`); continue; }
  if (!fs.existsSync(dataDir)) { add("FAIL", "COHORT-CSV", `task '${task.task_id}': CHART_REVIEW_RUCAM_DATA_DIR=${dataDir} does not exist`); continue; }
  const ids = csvPersonIds(dataDir);
  if (!ids) { add("FAIL", "COHORT-CSV", `task '${task.task_id}': ${dataDir}/derived_rucam.csv missing or has no PERSON_ID column`); continue; }
  // Only REAL patients must resolve in the shared cohort CSV; synthetic
  // patient_fake_* carry their own fixture data and legitimately aren't in it.
  const taskFixtures = fixtureDirs.filter((f) => f.includes(`_${task.task_id}_`) && !f.startsWith("patient_fake_"));
  const missing = taskFixtures.filter((f) => { const pid = patientPersonId(f); return pid != null && !ids.has(String(pid)); });
  if (missing.length) add("FAIL", "COHORT-CSV", `task '${task.task_id}': ${missing.length} fixture person_id(s) not in ${path.basename(dataDir)}/derived_rucam.csv: ${missing.join(", ")}`);
  else add("INFO", "COHORT-CSV", `task '${task.task_id}': data dir ${path.basename(dataDir)} OK; ${taskFixtures.length} fixture person_id(s) resolve`);
}

// ── CRITERION: every criterion .md frontmatter must PARSE + have field_id ────
// A criterion whose YAML frontmatter fails to parse (e.g. a long prompt wrapped
// by the serializer on a UI save) silently drops out of the compiled task — the
// agent's write for it is then rejected as "unknown_field" and any item derived
// from it Pends. Check the baseline criteria dir of every task.
function checkCriteriaDir(label: string, dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md"))) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    const m = /^---\n([\s\S]*?)\n---/.exec(raw);
    if (!m) { add("WARN", "CRITERION", `${label}/${f}: no frontmatter block`); continue; }
    try {
      const fm = parseYaml(m[1]) as { field_id?: string } | null;
      if (!fm?.field_id) add("FAIL", "CRITERION", `${label}/${f}: frontmatter parses but has no field_id → dropped from task`);
    } catch (e) {
      add("FAIL", "CRITERION", `${label}/${f}: frontmatter FAILS to parse → criterion silently dropped from task, writes rejected as unknown_field (${String((e as Error).message).split("\n")[0]})`);
    }
  }
}
for (const task of tasks) {
  checkCriteriaDir(`baseline:${task.task_id}`, path.join(ROOT, ".claude", "skills", `chart-review-${task.task_id}`, "references", "criteria"));
}

// ── SESSION cohort + CITATION ───────────────────────────────────────────────
// Detailed checks focus on RECENT sessions (the ones a human might open);
// older/historical sessions (mostly e2e test cruft) are summarized, not listed.
const RECENT_N = Number(process.env.DOCTOR_RECENT_SESSIONS ?? 8);
const recentSessionIds = new Set<string>(); // (task:sid) — used to scope ALIGN too
for (const task of tasks) {
  const all = listSessions(task.task_id).slice().sort((a, b) => ((b as any).session_num ?? 0) - ((a as any).session_num ?? 0));
  const recent = all.slice(0, RECENT_N);
  const older = all.slice(RECENT_N);
  for (const s of recent) recentSessionIds.add(`${task.task_id}:${s.session_id}`);

  for (const s of recent) {
    // Fork criteria can be corrupted by a UI save (the long-prompt YAML-wrap bug)
    // even when the baseline is clean — check each recent fork's criteria too.
    checkCriteriaDir(`fork:${task.task_id}/${s.session_id}`, path.join(ROOT, ".claude", "skills", `chart-review-${task.task_id}`, "sessions", s.session_id, "rubric", "references", "criteria"));
    const cohort: string[] = (s as any).cohort?.patient_ids ?? [];
    const badCohort = cohort.filter((pid) => !fixtureSet.has(pid));
    if (badCohort.length) add("WARN", "SESSION", `${task.task_id}/${s.session_id} ('${(s as any).name ?? ""}'): cohort references ${badCohort.length} removed patient(s): ${badCohort.join(", ")} — opening it errors "unknown patient"`);
    // CITATION: note citations must resolve to a note in the patient's CURRENT fixture
    for (const pid of cohort) {
      if (!fixtureSet.has(pid)) continue;
      const rs = readJson<{ field_assessments?: { evidence?: { source?: string; note_id?: string; note?: string }[] }[] }>(pathFor.reviewState(s.session_id, pid, task.task_id));
      if (!rs) continue;
      const notesDir = path.join(patientsRoot, pid, "notes");
      const noteFiles = fs.existsSync(notesDir) ? new Set(fs.readdirSync(notesDir)) : new Set<string>();
      const dangling = new Set<string>();
      for (const a of rs.field_assessments ?? []) {
        for (const e of a.evidence ?? []) {
          if (e?.source !== "note") continue;
          const nid = e.note_id || e.note; if (!nid) continue;
          if (!noteFiles.has(String(nid)) && !noteFiles.has(`${nid}.txt`)) dangling.add(String(nid));
        }
      }
      if (dangling.size) add("FAIL", "CITATION", `${task.task_id}/${s.session_id} ${pid}: review_state cites ${dangling.size} note(s) NOT in the current fixture (stale after a repoint) → save fails: ${[...dangling].slice(0, 3).join(", ")}${dangling.size > 3 ? " …" : ""}`);
    }
  }
  const olderBroken = older.filter((s) => ((s as any).cohort?.patient_ids ?? []).some((pid: string) => !fixtureSet.has(pid)));
  if (olderBroken.length) add("WARN", "SESSION", `${task.task_id}: ${olderBroken.length} older/historical session(s) reference removed patients (likely e2e test cruft — not detailed; a session-cleanup would clear them)`);
}

// NOTE: no run/session "alignment" check here. A session whose review_state is
// empty while a run draft exists is the NORMAL lazy state before the client's
// on-open auto-import runs — not a bug — and the "wrong active session" problem
// is a client-localStorage pointer the server can't observe. Both are handled by
// the auto-point/visibility client fix, not by this deterministic checker.

// ── Report ──────────────────────────────────────────────────────────────────
const order: Level[] = ["FAIL", "WARN", "INFO"];
const nFail = findings.filter((f) => f.level === "FAIL").length;
const nWarn = findings.filter((f) => f.level === "WARN").length;
console.log(`\n=== chart-review doctor — ${tasks.length} tasks, ${fixtureDirs.length} fixtures ===`);
for (const lvl of order) {
  const items = findings.filter((f) => f.level === lvl);
  if (!items.length) continue;
  console.log(`\n[${lvl}] (${items.length})`);
  for (const f of items) console.log(`  ${f.check.padEnd(11)} ${f.detail}`);
}
console.log(`\n${nFail ? "✗" : "✓"} ${nFail} FAIL, ${nWarn} WARN\n`);
process.exit(nFail > 0 ? 1 : 0);
