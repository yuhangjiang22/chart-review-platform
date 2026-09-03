// build-return-package — turn a site's local adherence results into an artifact
// that can LEAVE the site.
//
// The deployment shape this serves: a coordinating centre ships a frozen rubric
// to a participating site; the site annotates a calibration round, measures
// agreement, then runs the cohort at scale. Two things have to come back, and
// neither may carry PHI. This builds the second one — the concordance results.
//
// WHITELIST, NOT REDACTION. Every column emitted is named in COLUMNS below and
// every value passes a type check for that column. A field nobody listed does
// not appear, so a new field added upstream (an extra evidence shape, a new
// reviewer note) cannot leak by being forgotten — the failure mode of every
// "strip the PHI" pass. What is deliberately excluded:
//
//   evidence quotes   verbatim note text
//   reasoning         free text, unbounded
//   note_id           filenames carry dates
//   anchor.date, ts   dates are identifiers under HIPAA safe harbour
//   patient_id        a salted hash is a pseudonym, not an anonym — the package
//                     uses sequential subject ids and leaves the crosswalk on
//                     site, in a file written OUTSIDE the package directory
//
// Dates become INTERVALS: days_before_index. Analysis wants the spacing, and an
// offset from an unpublished anchor is not an identifier.
//
// Usage (from the platform root):
//   npx tsx scripts/asthma/return/build-return-package.ts --session session_130
//   npx tsx scripts/asthma/return/build-return-package.ts --run <run_id> [--run ...]
//   ... [--task asthma-adherence] [--out var/return-packages] [--site SITE-CODE]

import fs from "node:fs";
import path from "node:path";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
import { DERIVED_WORST_CONTROL_QID } from "@chart-review/rule-engine";
import { daysBefore, reasonCode, safeAnswer, scanForLeaks } from "./redact.js";
import { PLATFORM_ROOT } from "@chart-review/patients";

// ── argv ────────────────────────────────────────────────────────────────────

interface Args {
  sessions: string[]; runs: string[]; task: string; out: string; site: string;
}
function parseArgs(argv: string[]): Args {
  const a: Args = {
    sessions: [], runs: [], task: "asthma-adherence",
    out: path.join("var", "return-packages"), site: "SITE",
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--session": if (v) { a.sessions.push(v); i++; } break;
      case "--run": if (v) { a.runs.push(v); i++; } break;
      case "--task": if (v) { a.task = v; i++; } break;
      case "--out": if (v) { a.out = v; i++; } break;
      case "--site": if (v) { a.site = v; i++; } break;
    }
  }
  return a;
}

// ── the shapes we read ──────────────────────────────────────────────────────

interface Answer {
  question_id: string; tier?: number; answer: unknown; source?: string;
}
interface Event {
  event_id: string; rule_id: string;
  anchor: { type: string; date?: string; meta?: Record<string, unknown> };
  answers?: Answer[]; evaluable?: boolean; evaluable_reason?: string;
  verdict?: string; attribution?: string; source?: string;
}
interface Verdict {
  rule_id: string; verdict: string; attribution?: string; source?: string; rationale?: string;
}
interface Rollup {
  rule_id: string; n_events: number; n_evaluable: number; n_concordant: number;
  n_non_concordant: number; n_excluded: number; rate: number | null; period_verdict: string;
}
interface PatientResult {
  patient_id: string; source_kind: "session" | "run"; source_id: string;
  index_date?: string; review_status?: string; guideline_sha?: string;
  question_answers: Answer[]; rule_events: Event[];
  rule_verdicts: Verdict[]; rule_rollups: Rollup[];
}

// ── csv ─────────────────────────────────────────────────────────────────────

function csv(rows: Array<Record<string, string | number>>, columns: string[]): string {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c] ?? "")).join(","))]
    .join("\n") + "\n";
}

const COLUMNS = {
  verdicts: ["subject_id", "rule_id", "verdict", "attribution", "source"],
  rollups: ["subject_id", "rule_id", "n_events", "n_evaluable", "n_concordant",
            "n_non_concordant", "n_excluded", "rate", "period_verdict"],
  events: ["subject_id", "rule_id", "event_seq", "anchor_type", "days_before_index",
           "evaluable", "reason_code", "verdict", "attribution"],
  answers: ["subject_id", "question_id", "tier", "answer", "source"],
  by_rule: ["rule_id", "n_subjects", "n_evaluable_subjects", "n_concordant", "n_non_concordant",
            "n_excluded", "rate", "attr_DOCUMENTATION_GAP", "attr_GUIDELINE_DEVIATION",
            "attr_PATIENT_FACTOR", "attr_SYSTEM_FACTOR", "attr_unattributed"],
} as const;

// ── read ────────────────────────────────────────────────────────────────────

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}
function runsRoot(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(PLATFORM_ROOT, "var", "runs");
}
function readJson<T>(fp: string): T | null {
  try { return JSON.parse(fs.readFileSync(fp, "utf8")) as T; } catch { return null; }
}
function indexDateOf(patientId: string): string | undefined {
  const meta = readJson<{ index_date?: string }>(
    path.join(PLATFORM_ROOT, "corpus", "patients", patientId, "meta.json"));
  return meta?.index_date?.slice(0, 10);
}

function collect(args: Args): PatientResult[] {
  const out: PatientResult[] = [];
  const take = (
    pid: string, kind: "session" | "run", srcId: string, d: Record<string, unknown>,
  ) => {
    if (d.task_kind !== "adherence" && !Array.isArray(d.rule_verdicts)) return;
    out.push({
      patient_id: pid, source_kind: kind, source_id: srcId,
      index_date: indexDateOf(pid),
      review_status: d.review_status as string | undefined,
      // Which rubric produced this. The runner stamps lock_task_sha on a draft;
      // an imported review_state carries it on the work-list provenance instead.
      // A package that cannot name its rubric is not poolable across sites.
      guideline_sha: (d.lock_task_sha as string | undefined)
        ?? (d.rule_events_provenance as { guideline_sha?: string } | undefined)?.guideline_sha,
      question_answers: (d.question_answers as Answer[]) ?? [],
      rule_events: (d.rule_events as Event[]) ?? [],
      rule_verdicts: (d.rule_verdicts as Verdict[]) ?? [],
      rule_rollups: (d.rule_rollups as Rollup[]) ?? [],
    });
  };
  for (const sid of args.sessions) {
    const dir = path.join(reviewsRoot(), sid);
    if (!fs.existsSync(dir)) { console.error(`  ! session not found: ${sid}`); continue; }
    for (const pid of fs.readdirSync(dir).sort()) {
      const d = readJson<Record<string, unknown>>(
        path.join(dir, pid, args.task, "review_state.json"));
      if (d) take(pid, "session", sid, d);
    }
  }
  for (const rid of args.runs) {
    const dir = path.join(runsRoot(), rid, "per_patient");
    if (!fs.existsSync(dir)) { console.error(`  ! run not found: ${rid}`); continue; }
    for (const pid of fs.readdirSync(dir).sort()) {
      const d = readJson<Record<string, unknown>>(path.join(dir, pid, "agent_draft.json"));
      if (d) take(pid, "run", rid, d);
    }
  }
  return out;
}

// ── build ───────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.sessions.length === 0 && args.runs.length === 0) {
    console.error("usage: build-return-package.ts (--session <id> | --run <id>)... "
      + "[--task <id>] [--out <dir>] [--site <code>]");
    process.exit(2);
  }
  const skill = loadAdherenceSkill(args.task);
  const enumsByQid = new Map<string, Set<string>>();
  const tierByQid = new Map<string, number>();
  for (const [tier, qs] of skill.questions_by_tier) {
    for (const q of qs) {
      tierByQid.set(q.question_id, tier);
      const e = (q.answer_schema as { enum?: unknown[] } | undefined)?.enum;
      if (Array.isArray(e)) enumsByQid.set(q.question_id, new Set(e.map(String)));
    }
  }
  // The engine's derived patient-level value has no question, so no enum — but
  // it is a legitimate, non-identifying output and the analysis wants it (it is
  // what the comorbidity and referral rules gate on). It reduces over the
  // per-event control level, so it shares that question's value space.
  const controlEnum = enumsByQid.get("T1-ControlLevel");
  if (controlEnum) enumsByQid.set(DERIVED_WORST_CONTROL_QID, controlEnum);
  const ruleById = new Map(skill.rules.map((r) => [r.rule_id, r]));

  const patients = collect(args);
  if (patients.length === 0) { console.error("no adherence results found"); process.exit(1); }

  // Sequential subject ids. The site's salted patient_id is a pseudonym, not an
  // anonym — it is stable across every export the site ever makes, so it links
  // packages together. The crosswalk is written OUTSIDE the package.
  const subjectOf = new Map<string, string>();
  patients.forEach((p, i) => {
    if (!subjectOf.has(p.patient_id)) {
      subjectOf.set(p.patient_id, `S${String(subjectOf.size + 1).padStart(4, "0")}`);
    }
    void i;
  });

  const drops: string[] = [];
  const onDrop = (ctx: string) => (why: string) => drops.push(`${ctx}: ${why}`);

  const verdicts: Array<Record<string, string | number>> = [];
  const rollups: Array<Record<string, string | number>> = [];
  const events: Array<Record<string, string | number>> = [];
  const answers: Array<Record<string, string | number>> = [];

  for (const p of patients) {
    const sid = subjectOf.get(p.patient_id)!;
    for (const v of p.rule_verdicts) {
      verdicts.push({ subject_id: sid, rule_id: v.rule_id, verdict: v.verdict,
        attribution: v.attribution ?? "", source: v.source ?? "" });
    }
    for (const r of p.rule_rollups) {
      rollups.push({ subject_id: sid, rule_id: r.rule_id, n_events: r.n_events,
        n_evaluable: r.n_evaluable, n_concordant: r.n_concordant,
        n_non_concordant: r.n_non_concordant, n_excluded: r.n_excluded,
        rate: r.rate === null ? "" : r.rate, period_verdict: r.period_verdict });
    }
    const seqByRule = new Map<string, number>();
    for (const e of [...p.rule_events].sort((a, b) =>
      (a.anchor.date ?? "").localeCompare(b.anchor.date ?? ""))) {
      const n = (seqByRule.get(e.rule_id) ?? 0) + 1;
      seqByRule.set(e.rule_id, n);
      events.push({
        subject_id: sid, rule_id: e.rule_id, event_seq: n, anchor_type: e.anchor.type,
        days_before_index: daysBefore(p.index_date, e.anchor.date),
        evaluable: e.evaluable === false ? "false" : "true",
        reason_code: reasonCode(
          (ruleById.get(e.rule_id) as { event_censored_reason?: string } | undefined)?.event_censored_reason,
          e.evaluable_reason),
        verdict: e.verdict ?? "", attribution: e.attribution ?? "",
      });
    }
    for (const a of p.question_answers) {
      if (a.question_id.startsWith("_")) continue;      // engine-internal facts
      answers.push({
        subject_id: sid, question_id: a.question_id,
        tier: tierByQid.get(a.question_id) ?? a.tier ?? "",
        answer: safeAnswer(a.answer, enumsByQid.get(a.question_id), p.index_date,
          onDrop(`${a.question_id}`)),
        source: a.source ?? "",
      });
    }
  }

  // Cohort-level table — the one a paper reports.
  const byRule: Array<Record<string, string | number>> = [];
  for (const rule of skill.rules) {
    const rs = rollups.filter((r) => r.rule_id === rule.rule_id);
    const vs = verdicts.filter((v) => v.rule_id === rule.rule_id);
    const nEval = rs.filter((r) => Number(r.n_evaluable) > 0).length;
    const conc = vs.filter((v) => v.verdict === "CONCORDANT").length;
    const non = vs.filter((v) => v.verdict === "NON_CONCORDANT").length;
    const exc = vs.filter((v) => v.verdict === "EXCLUDED").length;
    const attr = (c: string) => vs.filter((v) => v.verdict === "NON_CONCORDANT" && v.attribution === c).length;
    byRule.push({
      rule_id: rule.rule_id, n_subjects: rs.length, n_evaluable_subjects: nEval,
      n_concordant: conc, n_non_concordant: non, n_excluded: exc,
      rate: conc + non > 0 ? (conc / (conc + non)).toFixed(4) : "",
      attr_DOCUMENTATION_GAP: attr("DOCUMENTATION_GAP"),
      attr_GUIDELINE_DEVIATION: attr("GUIDELINE_DEVIATION"),
      attr_PATIENT_FACTOR: attr("PATIENT_FACTOR"),
      attr_SYSTEM_FACTOR: attr("SYSTEM_FACTOR"),
      attr_unattributed: vs.filter((v) => v.verdict === "NON_CONCORDANT" && !v.attribution).length,
    });
  }

  const stamp = new Date().toISOString();
  const pkgId = `${args.site}-${args.task}-${stamp.replace(/[:.]/g, "-")}`;
  const dir = path.join(args.out, pkgId);
  fs.mkdirSync(dir, { recursive: true });

  const files: Record<string, string> = {
    "verdicts.csv": csv(verdicts, [...COLUMNS.verdicts]),
    "rollups.csv": csv(rollups, [...COLUMNS.rollups]),
    "events.csv": csv(events, [...COLUMNS.events]),
    "answers.csv": csv(answers, [...COLUMNS.answers]),
    "by_rule.csv": csv(byRule, [...COLUMNS.by_rule]),
  };

  // ── exit check ────────────────────────────────────────────────────────────
  // Whitelisting is the guarantee; this is the alarm that says it held. It runs
  // over the BYTES about to be written, not over the objects they came from.
  const findings = scanForLeaks(files);

  const runJson = {
    schema_version: "1",
    package_id: pkgId, site: args.site, task_id: args.task, generated_at: stamp,
    sources: { sessions: args.sessions, runs: args.runs },
    guideline_sha: [...new Set(patients.map((p) => p.guideline_sha).filter(Boolean))],
    n_subjects: subjectOf.size,
    n_results: patients.length,
    review_status_counts: patients.reduce<Record<string, number>>((m, p) => {
      const k = p.review_status ?? "unknown"; m[k] = (m[k] ?? 0) + 1; return m;
    }, {}),
    counts: { verdicts: verdicts.length, rollups: rollups.length, events: events.length, answers: answers.length },
    rules: skill.rules.map((r) => r.rule_id),
    dropped_values: drops.length,
    dropped_detail: [...new Set(drops)].slice(0, 50),
  };
  files["run.json"] = JSON.stringify(runJson, null, 2) + "\n";
  files["phi_check.json"] = JSON.stringify({
    checked_files: Object.keys(files).filter((f) => f.endsWith(".csv")),
    rules_applied: [
      "whitelist: only the columns declared in COLUMNS are emitted",
      "answers: booleans, finite numbers, and values declared in the question's enum only",
      "dates: converted to days_before_index, never emitted as calendar dates",
      "free text (evidence quotes, reasoning, reviewer-authored reasons): never emitted",
      "patient ids: sequential subject ids; the crosswalk stays on site",
    ],
    findings,
    passed: findings.length === 0,
  }, null, 2) + "\n";

  if (findings.length > 0) {
    console.error(`\nEXIT CHECK FAILED — ${findings.length} finding(s), package NOT written:`);
    for (const f of findings.slice(0, 10)) console.error(`   ${f.file}:${f.line}  ${f.why}`);
    fs.writeFileSync(path.join(dir, "phi_check.json"), files["phi_check.json"]!);
    process.exit(1);
  }

  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);

  // Crosswalk OUTSIDE the package directory, so "send the folder" cannot send it.
  const crosswalk = path.join(args.out, `${pkgId}.crosswalk.LOCAL-ONLY.csv`);
  fs.writeFileSync(crosswalk, csv(
    [...subjectOf.entries()].map(([pid, sid]) => ({ subject_id: sid, local_patient_id: pid })),
    ["subject_id", "local_patient_id"]));

  console.log(`\nreturn package: ${dir}`);
  for (const name of Object.keys(files)) {
    console.log(`   ${name.padEnd(16)} ${fs.statSync(path.join(dir, name)).size} bytes`);
  }
  console.log(`\n   subjects ${subjectOf.size} · verdicts ${verdicts.length} · events ${events.length} `
    + `· answers ${answers.length} · values dropped ${drops.length}`);
  console.log(`   exit check PASSED`);
  console.log(`\nLOCAL ONLY, do not send: ${crosswalk}`);
}

main();
