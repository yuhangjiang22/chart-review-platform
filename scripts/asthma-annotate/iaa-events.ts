// iaa-events.ts — CLI: per-event inter-annotator agreement for an
// adherence task's rule_events, between two sessions (spec 2026-08-24
// Task 7; statistically hardened in the Task 7 quality review, then again
// in the Task 7 re-review — see the Critical/Important markers below).
// Typically the agent's session vs a blind gold session, so the same
// number Task 6's compare view shows visually can be checked numerically.
//
// Usage:
//   npx tsx scripts/asthma-annotate/iaa-events.ts \
//     --session-a <sid> --session-b <sid> \
//     [--task asthma-adherence] [--agent-id <id>] [--patients p1,p2] \
//     [--json] [--force] [--allow-incomplete] [--allow-non-blind-gold]
//
// C1 — session A ("the agent's session") is read from
// `agent_rule_events[agent_id]`, NEVER from `rule_events`. `rule_events`
// gets overwritten IN PLACE the moment a human validates in the normal
// VALIDATE workflow (source flips to "reviewer", verdict re-derived) — so
// reading it for side A would compare the human's own correction against
// the gold, guaranteed agreement wherever the same person did both.
// `agent_rule_events[<agent_id>]` is the pristine, never-overwritten draft
// (server/adherence-iaa-routes.ts's readReviewer() filters
// `source === "reviewer"` for the identical dual-track reason — this CLI
// mirrors that same filesystem seam, pathFor.reviewState + a JSON read,
// but reads the shadow map instead of the live array). Session B (the gold
// session) reads `rule_events` directly — a blind session never imports
// agent output, so there's nothing to shadow.
//
// (Critical 1, Task 7 re-review) Session B being read straight from
// `rule_events` only stays safe as long as session B is ACTUALLY a clean
// blind pass. Two gates enforce that now, both refusing at exit 4:
//   - a session-manifest check (`blind: true` on session B), overridable
//     with --allow-non-blind-gold for a deliberate non-gold comparison;
//   - a per-patient contamination check on side B's review_state content
//     itself (imported_from_run set, a non-empty agent_* shadow map, or a
//     scored rule_event whose `source` isn't "reviewer") — this one has NO
//     override, because a contaminated gold can print a spuriously perfect
//     kappa (measured: 1.000) and this tool's whole posture is
//     refuse-rather-than-print.
//
// All I/O lives here; @chart-review/eval-adherence-iaa stays pure.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { pathFor } from "@chart-review/storage";
import { getSessionManifest } from "@chart-review/domain-iter";
import {
  computePerEventMetrics, type EventSide, type PerEventReport,
} from "@chart-review/eval-adherence-iaa";
import type { RuleEvent, RuleEventsProvenance } from "@chart-review/platform-types";

const TOOL_VERSION = "2.1.0"; // bumped for the Task 7 re-review fixes (new exit code, new envelope fields)

const HELP = `iaa-events — per-event inter-annotator agreement for an adherence task

Usage:
  npx tsx scripts/asthma-annotate/iaa-events.ts --session-a <sid> --session-b <sid> [options]

Options:
  --task <id>            Task id (default: asthma-adherence)
  --session-a <sid>       Session A id (required) — the agent's session.
                          Read from agent_rule_events[agent_id], never the
                          human-editable rule_events array (C1).
  --session-b <sid>       Session B id (required) — the gold session (e.g.
                          a blind annotation session). Read from
                          rule_events. Must be flagged blind:true in its
                          manifest, and its review_state must not carry
                          agent-imported provenance (Critical 1) — see exit
                          code 4.
  --agent-id <id>         Which agent's shadow draft to read from session A.
                          Default: the sole agent_id found across the
                          compared patients' agent_rule_events maps. Errors
                          if more than one is found and this isn't given.
  --patients p1,p2        Comma-separated patient_ids to compare. Each must
                          be in BOTH sessions' locked cohort.
                          Default: intersection of both sessions' cohorts.
  --json                  Print a JSON audit envelope (session ids, task,
                          agent_id, patients, dropped patients, blind
                          status, provenance, and the full PerEventReport)
                          instead of the human-readable report.
  --force                 Compute and print metrics even when the
                          provenance gate detects a worklist_hash mismatch
                          for a patient.
  --allow-incomplete      Compute and print the headline kappa even when
                          either side hasn't finished scoring every matched
                          event (completeness < 100%). Without this, an
                          incomplete pass refuses to print (same posture as
                          the provenance gate) — an in-progress annotation
                          would otherwise silently look more concordant
                          than a finished one (C2).
  --allow-non-blind-gold  Skip the refusal when session B's manifest lacks
                          blind: true (Critical 1). Without this, the CLI
                          refuses to treat a non-blind session as a gold
                          reference. Pass this ONLY when you have
                          independently verified session B's annotations
                          were not influenced by agent exposure (e.g. a
                          deliberate agent-vs-agent comparison, not
                          agent-vs-gold) — it does NOT bypass the
                          per-patient contamination check, which has no
                          override.
  --help, -h              Show this help and exit 0.

Exit codes:
  0  success
  1  bad arguments / session or task not found / no comparable patients /
     ambiguous or absent agent_id shadow map
  2  provenance gate tripped (worklist_hash mismatch) and --force not given
  3  completeness gate tripped (a side hasn't finished scoring) and
     --allow-incomplete not given
  4  blind-session integrity gate tripped (Critical 1): session B's
     manifest lacks blind:true and --allow-non-blind-gold not given, OR
     session B's review_state carries agent-imported provenance for one or
     more patients (imported_from_run set, a non-empty agent_* shadow map,
     or a scored rule_event whose source isn't "reviewer") — this second
     case has NO override flag

Per-event verdicts can themselves fall back to a patient-level judgment
when the agent left an anchored (omop-origin) event uncommitted — the
runner tracks this as "unansweredAnchored" on the agent DRAFT file
(var/runs/<run_id>/...), which is not copied into review_state.json and so
is not reachable from here. A high verdict_kappa / verdict_agreement does
not rule out patient-level fallback contamination; cross-check against the
run's own draft when that matters.

Read-only: never writes. Reads review_state.json for each patient under
both sessions via pathFor.reviewState + a distinguish-missing-from-corrupt
JSON read (packages/storage for path construction) — the same path
construction seam server/adherence-iaa-routes.ts uses to read reviewer
state.
`;

interface Args {
  task: string;
  sessionA?: string;
  sessionB?: string;
  agentId?: string;
  patients?: string[];
  json: boolean;
  force: boolean;
  allowIncomplete: boolean;
  allowNonBlindGold: boolean;
  help: boolean;
}

const VALUE_FLAGS = new Set(["--task", "--session-a", "--session-b", "--agent-id", "--patients"]);
const BOOL_FLAGS = new Set(["--json", "--force", "--allow-incomplete", "--allow-non-blind-gold", "--help", "-h"]);

/** Returns null (having already printed an error and set process.exitCode)
 *  on any parse failure — unrecognized flag, unknown positional argument,
 *  or a value-flag with no following value. */
export function parseArgs(argv: string[]): Args | null {
  const args: Args = {
    task: "asthma-adherence", json: false, force: false, allowIncomplete: false,
    allowNonBlindGold: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (BOOL_FLAGS.has(tok)) {
      if (tok === "--json") args.json = true;
      else if (tok === "--force") args.force = true;
      else if (tok === "--allow-incomplete") args.allowIncomplete = true;
      else if (tok === "--allow-non-blind-gold") args.allowNonBlindGold = true;
      else args.help = true; // --help / -h
      continue;
    }
    if (VALUE_FLAGS.has(tok)) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        console.error(`[iaa-events] ${tok} requires a value`);
        process.exitCode = 1;
        return null;
      }
      i++;
      if (tok === "--task") args.task = val;
      else if (tok === "--session-a") args.sessionA = val;
      else if (tok === "--session-b") args.sessionB = val;
      else if (tok === "--agent-id") args.agentId = val;
      else if (tok === "--patients") args.patients = val.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    console.error(`[iaa-events] unrecognized argument: ${tok} (--help for usage)`);
    process.exitCode = 1;
    return null;
  }
  return args;
}

export interface RuleEventsFile {
  rule_events?: RuleEvent[];
  agent_rule_events?: Record<string, RuleEvent[]>;
  rule_events_provenance?: RuleEventsProvenance;
  // Contamination-check fields (Critical 1, Task 7 re-review) — read but
  // never used for scoring. Mirrors AdherenceReview.tsx's
  // isBlindContaminated (client/src/ui/AdherenceReview.tsx ~line 264) so
  // this CLI refuses the same states the UI does. These live in the same
  // review_state.json document as rule_events; they were always present in
  // the parsed JSON, just never declared (or looked at) here before.
  imported_from_run?: string;
  agent_question_answers?: Record<string, unknown[]>;
  agent_rule_verdicts?: Record<string, unknown[]>;
}

export type ReadResult =
  | { ok: true; data: RuleEventsFile }
  | { ok: false; reason: "missing" | "parse_error" | "permission_error" };

/** Distinguishes "file doesn't exist" from "file exists but is corrupt"
 *  from "file exists but this process can't read it" (item 6 / minor,
 *  Task 7 re-review) — readJsonOrNull collapses all three to null, which
 *  silently reads a missing/corrupt/unreadable gold file as "annotated,
 *  zero events" and tanks enumeration without a trace. Every caller here
 *  drops the patient with a loud warning instead, and now with the RIGHT
 *  reason: an EACCES/EPERM on an otherwise-healthy file is an operator/
 *  filesystem problem, not evidence that someone wrote broken JSON — they
 *  call for different fixes (chmod vs re-annotate) and conflating them
 *  wastes the person debugging the dropped-patient list. */
export function readReviewStateFile(fp: string): ReadResult {
  if (!fs.existsSync(fp)) return { ok: false, reason: "missing" };
  let raw: string;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch {
    return { ok: false, reason: "permission_error" };
  }
  try {
    // KNOWN GAP (Task 7 re-review #3): this cast is unvalidated — a
    // review_state.json with the right JSON shape but wrong field types
    // (e.g. rule_events as a string, or a RuleEvent missing anchor) sails
    // through as `ok: true` and only breaks downstream, likely with a
    // less legible error than a schema validator would give here.
    return { ok: true, data: JSON.parse(raw) as RuleEventsFile };
  } catch {
    return { ok: false, reason: "parse_error" };
  }
}

export function toEventSides(patientId: string, events: RuleEvent[]): EventSide[] {
  return events.map((e) => ({
    patient_id: patientId,
    event_id: e.event_id,
    rule_id: e.rule_id,
    anchored: e.anchor.type !== "window" && !!e.anchor.date,
    origin: e.anchor.origin,
    verdict: e.verdict,
    evaluable: e.evaluable,
  }));
}

/** Mirrors AdherenceReview.tsx's isBlindContaminated (client/src/ui/
 *  AdherenceReview.tsx ~line 264) — a blind gold session must NEVER have
 *  imported agent output. Checked here on SIDE B specifically (Critical 1,
 *  Task 7 re-review): before this fix, the CLI parsed `imported_from_run`
 *  and `agent_rule_events` off side B's file (they were needed for other
 *  purposes) and never once looked at either for B — a contaminated "gold"
 *  (blind:true, imported_from_run set, a non-empty agent_rule_events map,
 *  and rule_events that were the agent's draft verbatim with
 *  source:"agent") printed "Global verdict kappa: 1.000" at exit 0, the
 *  single most misleading number this tool can produce. A third,
 *  independent signal below: a genuine gold event is stamped
 *  source:"reviewer" by the event-verdict route
 *  (server/adherence-routes.ts); any SCORED side-B event whose source is
 *  NOT "reviewer" is itself proof of contamination even if both flag-based
 *  signals were somehow cleared. No override flag exists for this check —
 *  see --allow-non-blind-gold's doc comment in HELP for why. */
export function isBlindContaminatedSideB(data: RuleEventsFile): boolean {
  if (data.imported_from_run) return true;
  const hasEntries = (m?: Record<string, unknown[]>) =>
    Object.values(m ?? {}).some((arr) => (arr ?? []).length > 0);
  if (
    hasEntries(data.agent_question_answers) ||
    hasEntries(data.agent_rule_verdicts) ||
    hasEntries(data.agent_rule_events)
  ) {
    return true;
  }
  for (const e of data.rule_events ?? []) {
    const scored = e.verdict !== undefined || e.evaluable === false;
    if (scored && e.source !== "reviewer") return true;
  }
  return false;
}

/** Applies isBlindContaminatedSideB across every comparable patient's side
 *  B, returning the contaminated patient_ids (empty when clean). */
export function findContaminatedPatients(
  comparable: Array<{ patient_id: string; b: { data: RuleEventsFile } }>,
): string[] {
  return comparable.filter((r) => isBlindContaminatedSideB(r.b.data)).map((r) => r.patient_id);
}

export type AgentIdResolution =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

/** (Important 4, Task 7 re-review) Extracted from main() so the C1
 *  agent-id resolution — the exact logic standing between side A reading
 *  the pristine shadow draft vs the human-editable live array — is unit
 *  testable without spawning the CLI as a subprocess. Pure: no I/O, no
 *  process.exit; failures come back as a result, not a side effect. */
export function resolveAgentId(
  comparable: Array<{ a: { data: RuleEventsFile } }>,
  explicitAgentId?: string,
): AgentIdResolution {
  if (explicitAgentId) return { ok: true, agentId: explicitAgentId };
  const seenAgentIds = new Set<string>();
  for (const r of comparable) {
    for (const k of Object.keys(r.a.data.agent_rule_events ?? {})) seenAgentIds.add(k);
  }
  if (seenAgentIds.size === 0) {
    return {
      ok: false,
      error:
        "no agent_rule_events shadow map found for any patient in session A — refusing to compare a " +
        "human-edited rule_events array against gold (C1). If session A truly has no agent import " +
        "(e.g. it is itself a blind/gold session), it cannot be used as --session-a.",
    };
  }
  if (seenAgentIds.size > 1) {
    return {
      ok: false,
      error: `ambiguous agent_id in session A: found [${[...seenAgentIds].join(", ")}] — pass --agent-id to disambiguate`,
    };
  }
  return { ok: true, agentId: [...seenAgentIds][0]! };
}

export interface ProvenanceMismatch { patient_id: string; hash_a: string; hash_b: string }

export interface ProvenanceCheckResult {
  mismatches: ProvenanceMismatch[];
  unchecked: string[];
  byPatient: Array<{
    patient_id: string; guideline_sha_a?: string; guideline_sha_b?: string;
    worklist_hash_a?: string; worklist_hash_b?: string;
  }>;
}

/** (Important 4, Task 7 re-review) Extracted from main() — pure gate
 *  predicate, no I/O, no process.exit. */
export function checkProvenance(
  comparable: Array<{ patient_id: string; a: { data: RuleEventsFile }; b: { data: RuleEventsFile } }>,
): ProvenanceCheckResult {
  const mismatches: ProvenanceMismatch[] = [];
  const unchecked: string[] = [];
  const byPatient: ProvenanceCheckResult["byPatient"] = [];
  for (const r of comparable) {
    const provA = r.a.data.rule_events_provenance;
    const provB = r.b.data.rule_events_provenance;
    byPatient.push({
      patient_id: r.patient_id,
      guideline_sha_a: provA?.guideline_sha, guideline_sha_b: provB?.guideline_sha,
      worklist_hash_a: provA?.worklist_hash, worklist_hash_b: provB?.worklist_hash,
    });
    if (provA && provB) {
      if (provA.worklist_hash !== provB.worklist_hash) {
        mismatches.push({ patient_id: r.patient_id, hash_a: provA.worklist_hash, hash_b: provB.worklist_hash });
      }
    } else {
      unchecked.push(r.patient_id);
    }
  }
  return { mismatches, unchecked, byPatient };
}

/** (Important 4, Task 7 re-review) Extracted from main() — pure gate
 *  predicate, no I/O, no process.exit. True when either side hasn't
 *  finished scoring every matched-anchored event. */
export function isIncomplete(report: PerEventReport): boolean {
  return (
    (report.enumeration.matched > 0 && Number.isFinite(report.completeness_a) && report.completeness_a < 1) ||
    (report.enumeration.matched > 0 && Number.isFinite(report.completeness_b) && report.completeness_b < 1)
  );
}

function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}

function fmtKappa(report: PerEventReport): string {
  if (Number.isFinite(report.verdict_kappa)) return report.verdict_kappa.toFixed(3);
  if (report.verdict_kappa_reason === "no_label_variance") {
    return `undefined (no label variance; raw agreement ${fmtPct(report.verdict_agreement)} over n=${report.verdict_n})`;
  }
  if (report.verdict_kappa_reason === "constant_rater_a" || report.verdict_kappa_reason === "constant_rater_b") {
    const who = report.verdict_kappa_reason === "constant_rater_a" ? "A (agent)" : "B (gold)";
    return `undefined (rater ${who} never varied; raw agreement ${fmtPct(report.verdict_agreement)} over n=${report.verdict_n} — kappa is mathematically forced to 0 here, not a real measurement)`;
  }
  return `undefined (insufficient pairs; n=${report.verdict_n})`;
}

interface DroppedPatient { patient_id: string; side: "a" | "b"; reason: string }

interface ReportMeta {
  task: string; sessionA: string; sessionB: string; agentId: string; patients: string[];
  dropped: DroppedPatient[]; unchecked: string[]; mismatches: ProvenanceMismatch[]; forced: boolean;
  allowedIncomplete: boolean;
  blindA: boolean; blindB: boolean; nonBlindGoldOverride: boolean;
}

function printHumanReport(report: PerEventReport, meta: ReportMeta): void {
  console.log(`IAA (per-event) — task=${meta.task}`);
  console.log(`  session A (agent): ${meta.sessionA}  agent_id=${meta.agentId}  blind=${meta.blindA}`);
  console.log(`  session B (gold):  ${meta.sessionB}  blind=${meta.blindB}`);
  console.log(`  patients compared (${meta.patients.length}): ${meta.patients.join(", ") || "(none)"}`);
  if (meta.nonBlindGoldOverride) {
    console.log(
      `  WARNING: --allow-non-blind-gold override in effect — session B is NOT flagged blind:true. ` +
      `Treat these numbers with suspicion; a non-blind annotator may have been influenced by agent ` +
      `output even without an explicit import.`,
    );
  }
  if (meta.dropped.length > 0) {
    console.log(`  DROPPED (missing/corrupt/unreadable review_state): ${meta.dropped.map((d) => `${d.patient_id}[${d.side}:${d.reason}]`).join(", ")}`);
  }
  if (meta.unchecked.length > 0) {
    console.log(`  denominator unchecked (no provenance) for: ${meta.unchecked.join(", ")}`);
  }
  if (meta.mismatches.length > 0) {
    console.log(`  PROVENANCE MISMATCH${meta.forced ? " (proceeding: --force)" : ""}: ${meta.mismatches.map((m) => m.patient_id).join(", ")}`);
  }
  console.log("");

  console.log("Per-rule verdict agreement (anchored + scored events only):");
  if (report.per_rule.length === 0) {
    console.log("  (no rule_events on either side)");
  } else {
    const ruleW = Math.max(7, ...report.per_rule.map((r) => r.rule_id.length));
    console.log(`  ${"rule_id".padEnd(ruleW)}  n_matched  n_scored  agreement  a_only  b_only`);
    for (const r of report.per_rule) {
      console.log(
        `  ${r.rule_id.padEnd(ruleW)}  ${String(r.n_matched).padEnd(9)}  ${String(r.n_scored).padEnd(8)}  ` +
        `${fmtPct(r.verdict_agreement).padEnd(9)}  ${String(r.a_only).padEnd(6)}  ${r.b_only}`,
      );
    }
  }
  console.log("");

  console.log(`Global verdict kappa (matched + scored anchored pairs): ${fmtKappa(report)}`);
  console.log(
    `Raw verdict agreement: ${fmtPct(report.verdict_agreement)} over n=${report.verdict_n} scored pairs ` +
    `(unscored: a=${report.n_unscored_a} b=${report.n_unscored_b} both=${report.n_unscored_both}; ` +
    `completeness a=${fmtPct(report.completeness_a)} b=${fmtPct(report.completeness_b)} of ${report.enumeration.matched} matched)`,
  );
  const aMarg = Object.entries(report.label_marginals.a).map(([k, v]) => `${k}=${v}`).join(" ") || "(none)";
  const bMarg = Object.entries(report.label_marginals.b).map(([k, v]) => `${k}=${v}`).join(" ") || "(none)";
  console.log(`  label marginals — A: ${aMarg}  |  B: ${bMarg}`);
  console.log("");

  console.log(
    `Enumeration, pooled (anchored events): matched=${report.enumeration.matched} ` +
    `a_only=${report.enumeration.a_only} b_only=${report.enumeration.b_only} jaccard=${fmtPct(report.enumeration.jaccard)}`,
  );
  const omop = report.enumeration.by_origin.omop;
  const note = report.enumeration.by_origin.note;
  console.log(
    `  seeded (omop-origin, expected ~identical by provenance construction): ` +
    `matched=${omop.matched} a_only=${omop.a_only} b_only=${omop.b_only} jaccard=${fmtPct(omop.jaccard)}`,
  );
  console.log(
    `  supplemented (note-origin — THE REAL SIGNAL): ` +
    `matched=${note.matched} a_only=${note.a_only} b_only=${note.b_only} jaccard=${fmtPct(note.jaccard)}`,
  );
  console.log(`Window-scoped events (reported separately, not scored): ${report.window_rules}`);
  if (meta.allowedIncomplete) {
    console.log("");
    // Reworded (Important 6, Task 7 re-review): the old text said the
    // numbers "include an in-progress annotation pass", which is the
    // opposite of what actually happens — unscored events are EXCLUDED,
    // not included, and that exclusion is exactly why an incomplete pass
    // can look better than a finished one (see Important 5 in
    // packages/eval-adherence-iaa/src/index.ts).
    console.log(
      "CAVEAT: --allow-incomplete was passed; the numbers above are computed only over the events both " +
      "sides finished; the unscored remainder is excluded, which biases agreement upward.",
    );
  }
}

function printJsonEnvelope(
  report: PerEventReport,
  meta: ReportMeta & {
    byPatient: Array<{
      patient_id: string;
      guideline_sha_a?: string; guideline_sha_b?: string;
      worklist_hash_a?: string; worklist_hash_b?: string;
    }>;
  },
): void {
  const envelope = {
    tool: "iaa-events",
    tool_version: TOOL_VERSION,
    generated_at: new Date().toISOString(),
    task: meta.task,
    session_a: { id: meta.sessionA, agent_id: meta.agentId, blind: meta.blindA },
    session_b: { id: meta.sessionB, blind: meta.blindB },
    // Minor (Task 7 re-review): both sessions' blind status archived
    // alongside the report — this envelope is the artifact filed next to a
    // manuscript, and "was session B actually blind" shouldn't require
    // digging up the manifest separately.
    blind: {
      session_a: meta.blindA, session_b: meta.blindB,
      neither_blind: !meta.blindA && !meta.blindB,
      non_blind_gold_override: meta.nonBlindGoldOverride,
    },
    patients: meta.patients,
    dropped_patients: meta.dropped,
    provenance: {
      mismatches: meta.mismatches,
      unchecked: meta.unchecked,
      forced: meta.forced,
      by_patient: meta.byPatient,
    },
    completeness: { allowed_incomplete: meta.allowedIncomplete },
    report,
  };
  console.log(JSON.stringify(envelope, null, 2));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;

  if (args.help) {
    console.log(HELP);
    process.exitCode = 0;
    return;
  }

  if (!args.sessionA || !args.sessionB) {
    console.error("[iaa-events] --session-a and --session-b are required (--help for usage)");
    process.exitCode = 1;
    return;
  }
  if (args.sessionA === args.sessionB) {
    console.error("[iaa-events] --session-a and --session-b must be different sessions");
    process.exitCode = 1;
    return;
  }

  const manifestA = getSessionManifest(args.task, args.sessionA);
  const manifestB = getSessionManifest(args.task, args.sessionB);
  if (!manifestA) {
    console.error(`[iaa-events] session ${args.sessionA} not found for task ${args.task}`);
    process.exitCode = 1;
    return;
  }
  if (!manifestB) {
    console.error(`[iaa-events] session ${args.sessionB} not found for task ${args.task}`);
    process.exitCode = 1;
    return;
  }

  const blindA = manifestA.blind === true;
  const blindB = manifestB.blind === true;

  // (Critical 1, Task 7 re-review) Session B must be a confirmed blind
  // gold pass by default — this used to be a bare console.warn that fired
  // only when NEITHER session was blind, so a session B that was never
  // blind to begin with sailed through silently.
  if (!blindB && !args.allowNonBlindGold) {
    console.error("");
    console.error("=".repeat(72));
    console.error(`[iaa-events] SESSION B IS NOT FLAGGED blind:true — refusing to treat ${args.sessionB} as a gold reference`);
    console.error("  This tool assumes session B is a blind annotation pass with no agent");
    console.error("  exposure. Pass --allow-non-blind-gold only if you have independently");
    console.error("  verified session B's annotations were not influenced by agent output");
    console.error("  (e.g. a deliberate agent-vs-agent comparison, not agent-vs-gold).");
    console.error("=".repeat(72));
    console.error("[iaa-events] refusing to proceed (pass --allow-non-blind-gold to override)");
    process.exitCode = 4;
    return;
  }
  const nonBlindGoldOverride = !blindB && args.allowNonBlindGold;

  const cohortA = new Set(manifestA.cohort?.patient_ids ?? []);
  const cohortB = new Set(manifestB.cohort?.patient_ids ?? []);

  let patients: string[];
  if (args.patients && args.patients.length > 0) {
    const invalid = args.patients.filter((p) => !cohortA.has(p) || !cohortB.has(p));
    if (invalid.length > 0) {
      console.error(
        `[iaa-events] --patients contains id(s) not in BOTH sessions' cohorts: ${invalid.join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
    patients = args.patients;
  } else {
    patients = [...cohortB].filter((p) => cohortA.has(p)).sort();
  }
  if (patients.length === 0) {
    console.error("[iaa-events] no comparable patients (empty intersection of both sessions' cohorts)");
    process.exitCode = 1;
    return;
  }

  // ── Read both sides for every candidate patient, once ───────────────────
  const reads = patients.map((pid) => ({
    patient_id: pid,
    a: readReviewStateFile(pathFor.reviewState(args.sessionA!, pid, args.task)),
    b: readReviewStateFile(pathFor.reviewState(args.sessionB!, pid, args.task)),
  }));

  const dropped: DroppedPatient[] = [];
  for (const r of reads) {
    if (!r.a.ok) dropped.push({ patient_id: r.patient_id, side: "a", reason: r.a.reason });
    if (!r.b.ok) dropped.push({ patient_id: r.patient_id, side: "b", reason: r.b.reason });
  }
  let comparable = reads.filter(
    (r): r is typeof r & { a: { ok: true; data: RuleEventsFile }; b: { ok: true; data: RuleEventsFile } } =>
      r.a.ok && r.b.ok,
  );
  if (comparable.length === 0) {
    console.error("[iaa-events] no comparable patients — every patient's review_state was missing or corrupt on at least one side");
    for (const d of dropped) console.error(`    ${d.patient_id} [${d.side}]: ${d.reason}`);
    process.exitCode = 1;
    return;
  }

  // ── Critical 1: refuse a contaminated gold — NO override ────────────────
  const contaminated = findContaminatedPatients(comparable);
  if (contaminated.length > 0) {
    console.error("");
    console.error("=".repeat(72));
    console.error("[iaa-events] CONTAMINATED GOLD — session B carries agent-imported provenance");
    console.error("  imported_from_run is set, an agent_* shadow map is non-empty, or a scored");
    console.error("  rule_event's source isn't \"reviewer\" for one or more patients. Session B");
    console.error("  is supposed to be a blind human annotation with ZERO agent exposure — this");
    console.error("  state can print a spuriously perfect kappa. There is NO override for this");
    console.error("  refusal (unlike --force / --allow-incomplete / --allow-non-blind-gold).");
    for (const pid of contaminated) console.error(`    ${pid}`);
    console.error("=".repeat(72));
    process.exitCode = 4;
    return;
  }

  // ── C1: resolve which agent's shadow draft to read for side A ──────────
  const resolution = resolveAgentId(comparable, args.agentId);
  if (!resolution.ok) {
    console.error(`[iaa-events] ${resolution.error}`);
    process.exitCode = 1;
    return;
  }
  const agentId = resolution.agentId;

  // Per-patient: the chosen agent_id's shadow must actually exist. A
  // heterogeneous gap (this agent never ran / wasn't imported for this one
  // patient) drops just that patient rather than refusing the whole run.
  // KNOWN GAP (Task 7 re-review #1): this only checks the shadow map
  // EXISTS for the patient — it doesn't check the shadow is CURRENT. A
  // shadow captured before a rubric bump (or before the ETL re-seeded the
  // work-list) can be stale — present, non-empty, provenance-matching at
  // the state level — while its events no longer reflect the current
  // anchor list. AdherenceReview.tsx has an agentShadowStale detector
  // (client/src/ui/AdherenceReview.tsx ~line 738: shadow coverage < half
  // of the current event count) for exactly this; this CLI doesn't port
  // it yet, so a stale-but-present shadow reads here as clean.
  const missingShadow = comparable.filter((r) => !r.a.data.agent_rule_events?.[agentId]);
  for (const r of missingShadow) {
    dropped.push({ patient_id: r.patient_id, side: "a", reason: `no agent_rule_events["${agentId}"] for this patient` });
  }
  comparable = comparable.filter((r) => r.a.data.agent_rule_events?.[agentId]);
  if (comparable.length === 0) {
    console.error(`[iaa-events] agent_id "${agentId}" has no shadow draft for any comparable patient`);
    process.exitCode = 1;
    return;
  }

  // ── Provenance gate ──────────────────────────────────────────────────
  const { mismatches, unchecked, byPatient } = checkProvenance(comparable);

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
      process.exitCode = 2;
      return;
    }
    console.error("[iaa-events] --force given — proceeding despite mismatch");
  }

  // ── Build EventSide[] and compute ───────────────────────────────────────
  const sideA: EventSide[] = [];
  const sideB: EventSide[] = [];
  for (const r of comparable) {
    sideA.push(...toEventSides(r.patient_id, r.a.data.agent_rule_events![agentId]!));
    sideB.push(...toEventSides(r.patient_id, r.b.data.rule_events ?? []));
  }

  let report: PerEventReport;
  try {
    report = computePerEventMetrics(sideA, sideB);
  } catch (err) {
    console.error(`[iaa-events] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // ── Completeness gate (C2, CLI posture matches the provenance gate) ────
  const incomplete = isIncomplete(report);
  if (incomplete && !args.allowIncomplete) {
    console.error("");
    console.error("=".repeat(72));
    console.error("[iaa-events] INCOMPLETE ANNOTATION — a side hasn't finished scoring every matched event");
    console.error(
      `  completeness: A=${fmtPct(report.completeness_a)} B=${fmtPct(report.completeness_b)} ` +
      `(unscored: a=${report.n_unscored_a} b=${report.n_unscored_b} both=${report.n_unscored_both})`,
    );
    console.error("  An in-progress pass can look more concordant than a finished one (C2).");
    console.error("=".repeat(72));
    console.error("[iaa-events] refusing to print the headline kappa (pass --allow-incomplete to override)");
    process.exitCode = 3;
    return;
  }

  const patientIds = comparable.map((r) => r.patient_id).sort();
  const meta: ReportMeta = {
    task: args.task, sessionA: args.sessionA, sessionB: args.sessionB, agentId, patients: patientIds,
    dropped, unchecked, mismatches, forced: args.force, allowedIncomplete: incomplete && args.allowIncomplete,
    blindA, blindB, nonBlindGoldOverride,
  };

  if (args.json) {
    printJsonEnvelope(report, { ...meta, byPatient });
  } else {
    printHumanReport(report, meta);
  }
  process.exitCode = 0;
}

// (Important 4, Task 7 re-review) Only auto-run as a CLI when this file is
// executed directly — not when imported for its exported pure functions
// (agent-id resolver, gate predicates, EventSide mapper) by
// iaa-events.test.ts. Without this guard, importing ANYTHING from this
// module for unit testing would also kick off main() as an unwanted side
// effect (real process.argv parsing, real session lookups).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[iaa-events] fatal:", err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  });
}
