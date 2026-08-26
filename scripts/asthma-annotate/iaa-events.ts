// iaa-events.ts — CLI: per-event inter-annotator agreement for an
// adherence task's rule_events, between two sessions (spec 2026-08-24
// Task 7). Typically the agent's session vs a blind gold session, so the
// same number Task 6's compare view shows visually can be checked
// numerically.
//
// Usage:
//   npx tsx scripts/asthma-annotate/iaa-events.ts \
//     --session-a <sid> --session-b <sid> \
//     [--task asthma-adherence] [--patients p1,p2] [--json] [--force]
//
// Reads each session's per-patient review_state.json via the same
// storage seam server/adherence-iaa-routes.ts's readReviewer() uses
// (pathFor.reviewState + readJsonOrNull — see packages/storage), maps
// rule_events -> EventSide[] (anchored = anchor.type !== "window" &&
// !!anchor.date), and runs computePerEventMetrics from
// @chart-review/eval-adherence-iaa. All I/O lives here; the package stays
// pure.
//
// Default --patients is the INTERSECTION of both sessions' cohort
// patient_ids (via getSessionManifest) — deliberately NOT a directory
// scan (the phantom-state hazard hit during Task 6: a stray dir under
// var/reviews/<session>/ that was never actually part of the session's
// locked cohort must not silently join the comparison).
//
// PROVENANCE GATE: rule_events_provenance.worklist_hash is stamped every
// time a patient's work-list is seeded (agent runner OR the blind
// seed-events route). If a patient carries provenance on both sides and
// the hashes differ, the two sides were seeded against different
// denominators (an ETL re-run or rubric bump shifted the anchor lists
// between the agent's seed and the gold seed) — enumeration agreement
// would misreport that shift as human-vs-agent disagreement. Refuses
// (non-zero exit, no metrics printed) unless --force. When either side
// lacks provenance for a patient, the denominator can't be checked at
// all — printed as a note, never blocking.

import { pathFor, readJsonOrNull } from "@chart-review/storage";
import { getSessionManifest } from "@chart-review/domain-iter";
import {
  computePerEventMetrics, type EventSide, type PerEventReport,
} from "@chart-review/eval-adherence-iaa";
import type { RuleEvent, RuleEventsProvenance } from "@chart-review/platform-types";

const HELP = `iaa-events — per-event inter-annotator agreement for an adherence task

Usage:
  npx tsx scripts/asthma-annotate/iaa-events.ts --session-a <sid> --session-b <sid> [options]

Options:
  --task <id>          Task id (default: asthma-adherence)
  --session-a <sid>     Session A id (required) — e.g. the agent's session
  --session-b <sid>     Session B id (required) — e.g. a blind gold session
  --patients p1,p2      Comma-separated patient_ids to compare.
                        Default: intersection of both sessions' cohort.patient_ids.
  --json                Print the raw PerEventReport as JSON instead of the
                        human-readable table.
  --force               Compute and print metrics even when the provenance
                        gate detects a worklist_hash mismatch for a patient.
  --help, -h            Show this help and exit 0.

Exit codes:
  0  success
  1  bad arguments / session or task not found / no comparable patients
  2  provenance gate tripped (worklist_hash mismatch) and --force not given

Reads review_state.json for each patient under both sessions via
pathFor.reviewState + readJsonOrNull (packages/storage) — the same seam
server/adherence-iaa-routes.ts uses to read reviewer state. Read-only:
never writes.
`;

interface Args {
  task: string;
  sessionA?: string;
  sessionB?: string;
  patients?: string[];
  json: boolean;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { task: "asthma-adherence", json: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--task": args.task = argv[++i] ?? args.task; break;
      case "--session-a": args.sessionA = argv[++i]; break;
      case "--session-b": args.sessionB = argv[++i]; break;
      case "--patients":
        args.patients = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--json": args.json = true; break;
      case "--force": args.force = true; break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`[iaa-events] unrecognized flag: ${a}`);
          process.exit(1);
        }
    }
  }
  return args;
}

interface RuleEventsFile {
  rule_events?: RuleEvent[];
  rule_events_provenance?: RuleEventsProvenance;
}

/** Mirrors readReviewer()'s read pattern in server/adherence-iaa-routes.ts:
 *  pathFor.reviewState(sessionId, patientId, taskId) + a JSON read that
 *  tolerates a missing/corrupt file by returning an empty view. */
function readRuleEvents(sessionId: string, patientId: string, taskId: string): RuleEventsFile {
  const fp = pathFor.reviewState(sessionId, patientId, taskId);
  const parsed = readJsonOrNull<RuleEventsFile>(fp);
  return parsed ?? { rule_events: [] };
}

function toEventSides(patientId: string, events: RuleEvent[]): EventSide[] {
  return events.map((e) => ({
    patient_id: patientId,
    event_id: e.event_id,
    rule_id: e.rule_id,
    anchored: e.anchor.type !== "window" && !!e.anchor.date,
    verdict: e.verdict,
    evaluable: e.evaluable,
  }));
}

function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}
function fmtKappa(x: number): string {
  return Number.isFinite(x) ? x.toFixed(3) : "n/a (insufficient pairs)";
}

function printReport(
  report: PerEventReport,
  meta: { task: string; sessionA: string; sessionB: string; patients: string[] },
): void {
  console.log(`IAA (per-event) — task=${meta.task}`);
  console.log(`  session A: ${meta.sessionA}`);
  console.log(`  session B: ${meta.sessionB}`);
  console.log(`  patients (${meta.patients.length}): ${meta.patients.join(", ") || "(none)"}`);
  console.log("");
  console.log("Per-rule verdict agreement (anchored events only):");
  const rows = report.per_rule;
  if (rows.length === 0) {
    console.log("  (no rule_events on either side)");
  } else {
    const ruleW = Math.max(7, ...rows.map((r) => r.rule_id.length));
    console.log(
      `  ${"rule_id".padEnd(ruleW)}  n_matched  agreement  a_only  b_only`,
    );
    for (const r of rows) {
      console.log(
        `  ${r.rule_id.padEnd(ruleW)}  ${String(r.n_matched).padEnd(9)}  ` +
        `${fmtPct(r.verdict_agreement).padEnd(9)}  ${String(r.a_only).padEnd(6)}  ${r.b_only}`,
      );
    }
  }
  console.log("");
  console.log(`Global verdict kappa (anchored matched pairs): ${fmtKappa(report.verdict_kappa)}`);
  console.log(
    `Enumeration (anchored events): matched=${report.enumeration.matched} ` +
    `a_only=${report.enumeration.a_only} b_only=${report.enumeration.b_only} ` +
    `jaccard=${fmtPct(report.enumeration.jaccard)}`,
  );
  console.log(`Window rules (reported separately, not scored): ${report.window_rules}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!args.sessionA || !args.sessionB) {
    console.error("[iaa-events] --session-a and --session-b are required (--help for usage)");
    process.exit(1);
  }

  const manifestA = getSessionManifest(args.task, args.sessionA);
  const manifestB = getSessionManifest(args.task, args.sessionB);
  if (!manifestA) {
    console.error(`[iaa-events] session ${args.sessionA} not found for task ${args.task}`);
    process.exit(1);
  }
  if (!manifestB) {
    console.error(`[iaa-events] session ${args.sessionB} not found for task ${args.task}`);
    process.exit(1);
  }

  let patients: string[];
  if (args.patients && args.patients.length > 0) {
    patients = args.patients;
  } else {
    const cohortA = new Set(manifestA.cohort.patient_ids);
    patients = manifestB.cohort.patient_ids.filter((p) => cohortA.has(p)).sort();
  }

  if (patients.length === 0) {
    console.error(
      "[iaa-events] no comparable patients (empty --patients intersection of both sessions' cohorts)",
    );
    process.exit(1);
  }

  // ── Provenance gate ────────────────────────────────────────────────────
  const mismatches: Array<{ patient_id: string; hash_a: string; hash_b: string }> = [];
  const unchecked: string[] = [];
  const stateByPatient = new Map<
    string,
    { a: RuleEventsFile; b: RuleEventsFile }
  >();

  for (const pid of patients) {
    const a = readRuleEvents(args.sessionA, pid, args.task);
    const b = readRuleEvents(args.sessionB, pid, args.task);
    stateByPatient.set(pid, { a, b });
    const provA = a.rule_events_provenance;
    const provB = b.rule_events_provenance;
    if (provA && provB) {
      if (provA.worklist_hash !== provB.worklist_hash) {
        mismatches.push({ patient_id: pid, hash_a: provA.worklist_hash, hash_b: provB.worklist_hash });
      }
    } else {
      unchecked.push(pid);
    }
  }

  if (unchecked.length > 0) {
    console.warn(
      `[iaa-events] denominator unchecked (no provenance) for ${unchecked.length} patient(s): ${unchecked.join(", ")}`,
    );
  }

  if (mismatches.length > 0) {
    console.error("");
    console.error("=".repeat(72));
    console.error("[iaa-events] PROVENANCE MISMATCH — worklist_hash differs between sessions");
    console.error("  Sessions were seeded against different denominators (ETL re-run or");
    console.error("  rubric bump between the two seeds). Enumeration agreement would");
    console.error("  misreport that shift as human-vs-agent disagreement.");
    for (const m of mismatches) {
      console.error(`    ${m.patient_id}: A=${m.hash_a.slice(0, 12)}… B=${m.hash_b.slice(0, 12)}…`);
    }
    console.error("=".repeat(72));
    if (!args.force) {
      console.error("[iaa-events] refusing to print metrics (pass --force to override)");
      process.exit(2);
    }
    console.error("[iaa-events] --force given — proceeding despite mismatch");
    console.error("");
  }

  // ── Build EventSide[] and compute ───────────────────────────────────────
  const sideA: EventSide[] = [];
  const sideB: EventSide[] = [];
  for (const pid of patients) {
    const { a, b } = stateByPatient.get(pid)!;
    sideA.push(...toEventSides(pid, a.rule_events ?? []));
    sideB.push(...toEventSides(pid, b.rule_events ?? []));
  }

  const report = computePerEventMetrics(sideA, sideB);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, { task: args.task, sessionA: args.sessionA, sessionB: args.sessionB, patients });
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[iaa-events] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
