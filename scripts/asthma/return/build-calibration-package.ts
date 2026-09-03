// build-calibration-package — the FIRST artifact a participating site sends back.
//
// Before a site runs its cohort at scale it annotates a calibration round and
// measures whether the agent reproduces its own annotators. This packages that
// measurement: per-question and per-rule agreement, per-event agreement, and an
// advisory gate against thresholds the coordinating centre sets.
//
// Same whitelist discipline as build-return-package (shared redact.ts): subject
// ids, no dates, no free text. Event ids are the trap here — they are built from
// anchor dates ("R-Step@2025-11-15@encounters:12") — so disagreements are keyed
// by (rule, event_seq) instead, with the sequence assigned in date order locally.
//
// WHAT THIS NUMBER IS. The reviewer column is an ADJUDICATED gold: the annotator
// worked from the agent's draft, so an answer they accepted unchanged agrees with
// the agent by construction. That makes this agreement an UPPER BOUND on what a
// blind annotator would produce, and the report says so with the counts, rather
// than letting a site read 0.9 as independent agreement.
//
// Usage (from the platform root):
//   npx tsx scripts/asthma/return/build-calibration-package.ts --session <id> \
//       [--task asthma-adherence] [--site SITE] [--kappa-min 0.6] [--min-n 20]

import fs from "node:fs";
import path from "node:path";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
import { PLATFORM_ROOT } from "@chart-review/patients";
import {
  computeAdherenceIaa, computePerEventMetrics, type EventSide,
} from "@chart-review/eval-adherence-iaa";
import type { QuestionAnswer, RuleVerdict, RuleEvent } from "@chart-review/platform-types";
import { scanForLeaks } from "./redact.js";

interface Args {
  session: string; task: string; out: string; site: string;
  kappaMin: number; minN: number;
}
function parseArgs(argv: string[]): Args {
  const a: Args = {
    session: "", task: "asthma-adherence", site: "SITE",
    out: path.join("var", "return-packages"), kappaMin: 0.6, minN: 20,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--session": if (v) { a.session = v; i++; } break;
      case "--task": if (v) { a.task = v; i++; } break;
      case "--out": if (v) { a.out = v; i++; } break;
      case "--site": if (v) { a.site = v; i++; } break;
      case "--kappa-min": if (v) { a.kappaMin = Number(v); i++; } break;
      case "--min-n": if (v) { a.minN = Number(v); i++; } break;
    }
  }
  return a;
}

function csv(rows: Array<Record<string, string | number>>, columns: string[]): string {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c] ?? "")).join(","))]
    .join("\n") + "\n";
}
const num = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : "");

interface StateFile {
  question_answers?: QuestionAnswer[];
  rule_verdicts?: RuleVerdict[];
  rule_events?: RuleEvent[];
  agent_question_answers?: Record<string, QuestionAnswer[]>;
  agent_rule_verdicts?: Record<string, RuleVerdict[]>;
  agent_rule_events?: Record<string, RuleEvent[]>;
  review_status?: string;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.session) {
    console.error("usage: build-calibration-package.ts --session <id> [--task <id>] "
      + "[--site <code>] [--kappa-min 0.6] [--min-n 20]");
    process.exit(2);
  }
  const skill = loadAdherenceSkill(args.task);
  const reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT
    ?? path.join(PLATFORM_ROOT, "var", "reviews");
  const dir = path.join(reviewsRoot, args.session);
  if (!fs.existsSync(dir)) { console.error(`session not found: ${args.session}`); process.exit(1); }

  const subjectOf = new Map<string, string>();
  const agentQ = new Map<string, QuestionAnswer[]>();
  const revQ = new Map<string, QuestionAnswer[]>();
  const agentR = new Map<string, RuleVerdict[]>();
  const revR = new Map<string, RuleVerdict[]>();
  const agentEvents: EventSide[] = [];
  const revEvents: EventSide[] = [];
  // event_id -> "<rule>#<seq>", so a disagreement can be named without its date.
  const seqOf = new Map<string, string>();
  let acceptedUnchanged = 0, changed = 0, validated = 0, total = 0;

  for (const pid of fs.readdirSync(dir).sort()) {
    const fp = path.join(dir, pid, args.task, "review_state.json");
    if (!fs.existsSync(fp)) continue;
    let d: StateFile;
    try { d = JSON.parse(fs.readFileSync(fp, "utf8")) as StateFile; } catch { continue; }
    total++;
    if (d.review_status === "reviewer_validated") validated++;
    const sid = `S${String(subjectOf.size + 1).padStart(4, "0")}`;
    subjectOf.set(pid, sid);

    const agentIds = Object.keys(d.agent_question_answers ?? {}).sort();
    const firstAgent = agentIds[0];
    const aQ = firstAgent ? (d.agent_question_answers?.[firstAgent] ?? []) : [];
    const rQ = (d.question_answers ?? []).filter((q) => q.source === "reviewer");
    agentQ.set(sid, aQ); revQ.set(sid, rQ);

    // Independence caveat, counted rather than asserted.
    const aByQ = new Map(aQ.map((q) => [q.question_id, q.answer]));
    for (const q of rQ) {
      if (!aByQ.has(q.question_id)) continue;
      if (JSON.stringify(aByQ.get(q.question_id) ?? null) === JSON.stringify(q.answer ?? null)) {
        acceptedUnchanged++;
      } else changed++;
    }

    const agentVs = firstAgent ? (d.agent_rule_verdicts?.[firstAgent] ?? []) : [];
    agentR.set(sid, agentVs);
    revR.set(sid, (d.rule_verdicts ?? []).filter((r) => r.source === "reviewer"));

    // Event sequence numbers, in date order, per rule — the same convention the
    // results package uses, so the two artifacts can be joined.
    const ordered = [...(d.rule_events ?? [])].sort((x, y) =>
      (x.anchor.date ?? "").localeCompare(y.anchor.date ?? ""));
    const perRule = new Map<string, number>();
    for (const e of ordered) {
      const n = (perRule.get(e.rule_id) ?? 0) + 1;
      perRule.set(e.rule_id, n);
      seqOf.set(e.event_id, `${e.rule_id}#${n}`);
    }
    const asSide = (evs: RuleEvent[]): EventSide[] => evs.map((e) => ({
      patient_id: sid, event_id: e.event_id, rule_id: e.rule_id,
      anchor: e.anchor, verdict: e.verdict, evaluable: e.evaluable,
    } as unknown as EventSide));
    revEvents.push(...asSide((d.rule_events ?? []).filter((e) => e.source === "reviewer")));
    if (firstAgent) agentEvents.push(...asSide(d.agent_rule_events?.[firstAgent] ?? []));
  }

  if (subjectOf.size === 0) { console.error("no review states in that session"); process.exit(1); }

  const iaa = computeAdherenceIaa({
    agent_question_answers: agentQ, reviewer_question_answers: revQ,
    agent_rule_verdicts: agentR, reviewer_rule_verdicts: revR,
  });
  const evt = computePerEventMetrics(agentEvents, revEvents);

  const perQuestion = iaa.per_question.map((m) => ({
    question_id: m.question_id, tier: m.tier ?? "", n: m.n,
    agreement: num(m.agreement), kappa: num(m.kappa),
  }));
  const perRule = iaa.per_rule.map((m) => ({
    rule_id: m.rule_id, n: m.n, agreement: num(m.agreement), kappa: num(m.kappa),
    n_disagreements: m.disagreements.length,
  }));
  const disagreements = iaa.per_rule.flatMap((m) => m.disagreements.map((x) => ({
    subject_id: x.patient_id, rule_id: m.rule_id,
    agent_verdict: x.agent, reviewer_verdict: x.reviewer,
  })));
  const perEvent = evt.per_rule.map((m) => ({
    rule_id: m.rule_id, n_matched: m.n_matched, n_scored: m.n_scored,
    verdict_agreement: num(m.verdict_agreement),
    agent_only: m.a_only, reviewer_only: m.b_only,
    n_disagreements: m.disagreements.length,
  }));
  const eventDisagreements = evt.per_rule.flatMap((m) => m.disagreements.map((x) => ({
    subject_id: x.patient_id, event_key: seqOf.get(x.event_id) ?? `${m.rule_id}#?`,
    agent: x.a, reviewer: x.b,
  })));

  // Advisory gate. The thresholds are the coordinating centre's parameters, not
  // this script's opinion: kappa-min defaults to 0.60 (Landis & Koch's
  // "substantial") and min-n to 20 scored pairs, below which a kappa moves too
  // far on one patient to mean anything. Rules that fail are NAMED, because
  // "calibration failed" is unactionable while "these three rules disagree" is
  // the input to a rubric revision.
  const gated = iaa.per_rule.map((m) => ({
    rule_id: m.rule_id, n: m.n, kappa: m.kappa,
    enough_n: m.n >= args.minN,
    meets_kappa: Number.isFinite(m.kappa) && m.kappa >= args.kappaMin,
  }));
  const failing = gated.filter((g) => !g.meets_kappa || !g.enough_n);
  const stamp = new Date().toISOString();
  const pkgId = `${args.site}-${args.task}-calibration-${stamp.replace(/[:.]/g, "-")}`;

  const files: Record<string, string> = {
    "per_question.csv": csv(perQuestion, ["question_id", "tier", "n", "agreement", "kappa"]),
    "per_rule.csv": csv(perRule, ["rule_id", "n", "agreement", "kappa", "n_disagreements"]),
    "rule_disagreements.csv": csv(disagreements,
      ["subject_id", "rule_id", "agent_verdict", "reviewer_verdict"]),
    "per_event.csv": csv(perEvent, ["rule_id", "n_matched", "n_scored", "verdict_agreement",
      "agent_only", "reviewer_only", "n_disagreements"]),
    "event_disagreements.csv": csv(eventDisagreements,
      ["subject_id", "event_key", "agent", "reviewer"]),
  };

  const findings = scanForLeaks(files);

  files["gate.json"] = JSON.stringify({
    schema_version: "1",
    package_id: pkgId, site: args.site, task_id: args.task, generated_at: stamp,
    session: args.session,
    n_subjects: subjectOf.size, n_reviewer_validated: validated, n_states: total,
    thresholds: { kappa_min: args.kappaMin, min_n_per_rule: args.minN },
    questions_kappa_macro: Number.isFinite(iaa.questions_kappa_macro) ? iaa.questions_kappa_macro : null,
    rules_kappa_macro: Number.isFinite(iaa.rules_kappa_macro) ? iaa.rules_kappa_macro : null,
    event_verdict_kappa: Number.isFinite(evt.verdict_kappa) ? evt.verdict_kappa : null,
    event_verdict_kappa_reason: evt.verdict_kappa_reason ?? null,
    rules_failing_gate: failing.map((f) => ({
      rule_id: f.rule_id, n: f.n,
      kappa: Number.isFinite(f.kappa) ? f.kappa : null,
      reason: !f.enough_n ? "n below min_n_per_rule" : "kappa below kappa_min",
    })),
    gate_passed: failing.length === 0 && validated === total && total > 0,
    // Read this before reading the numbers above.
    independence_caveat: {
      note: "The reviewer column is an ADJUDICATED gold: the annotator worked from "
        + "the agent's draft, so an answer accepted unchanged agrees by construction. "
        + "These figures are an UPPER BOUND on blind agreement.",
      reviewer_answers_identical_to_agent: acceptedUnchanged,
      reviewer_answers_changed: changed,
      share_identical: acceptedUnchanged + changed > 0
        ? Number((acceptedUnchanged / (acceptedUnchanged + changed)).toFixed(4)) : null,
    },
  }, null, 2) + "\n";
  files["phi_check.json"] = JSON.stringify({
    checked_files: Object.keys(files).filter((f) => f.endsWith(".csv")),
    rules_applied: [
      "whitelist: only declared columns are emitted",
      "event ids replaced by rule#sequence — the id itself is built from an anchor date",
      "no free text: disagreements carry verdict labels only",
      "subject ids are sequential; the crosswalk stays on site",
    ],
    findings, passed: findings.length === 0,
  }, null, 2) + "\n";

  const outDir = path.join(args.out, pkgId);
  fs.mkdirSync(outDir, { recursive: true });
  if (findings.length > 0) {
    console.error(`\nEXIT CHECK FAILED — ${findings.length} finding(s), package NOT written:`);
    for (const f of findings.slice(0, 10)) console.error(`   ${f.file}:${f.line}  ${f.why}`);
    fs.writeFileSync(path.join(outDir, "phi_check.json"), files["phi_check.json"]!);
    process.exit(1);
  }
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), body);
  fs.writeFileSync(path.join(args.out, `${pkgId}.crosswalk.LOCAL-ONLY.csv`), csv(
    [...subjectOf.entries()].map(([pid, sid]) => ({ subject_id: sid, local_patient_id: pid })),
    ["subject_id", "local_patient_id"]));

  console.log(`\ncalibration package: ${outDir}`);
  console.log(`   subjects ${subjectOf.size} (validated ${validated}/${total})`);
  console.log(`   questions kappa macro  ${num(iaa.questions_kappa_macro)}`);
  console.log(`   rules kappa macro      ${num(iaa.rules_kappa_macro)}`);
  console.log(`   event verdict kappa    ${num(evt.verdict_kappa)}`
    + (evt.verdict_kappa_reason ? `  (${evt.verdict_kappa_reason})` : ""));
  console.log(`   gate (kappa>=${args.kappaMin}, n>=${args.minN}): `
    + (failing.length === 0 ? "PASS" : `FAIL on ${failing.length} rule(s)`));
  for (const f of failing.slice(0, 8)) {
    console.log(`      ${f.rule_id.padEnd(42)} n=${f.n} kappa=${num(f.kappa)}`);
  }
  const share = acceptedUnchanged + changed > 0
    ? (acceptedUnchanged / (acceptedUnchanged + changed) * 100).toFixed(0) : "-";
  console.log(`\n   NOTE: ${share}% of reviewer answers are identical to the agent's draft `
    + "(adjudicated gold — these figures are an upper bound on blind agreement).");
  console.log(`\nLOCAL ONLY, do not send: ${path.join(args.out, `${pkgId}.crosswalk.LOCAL-ONLY.csv`)}`);
}

main();
