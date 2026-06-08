// Per-patient + cohort composite adherence summary.
//
// GET /api/pilots/:taskId/:iterId/adherence-summary
//   → cohort-level aggregate {n_patients, by_patient[], cohort: {overall, by_attribution}}
//
// GET /api/pilots/:taskId/:iterId/adherence-summary/:patientId
//   → one patient's {overall_score, n_evaluable, n_concordant,
//                     n_excluded, by_attribution, by_rule[]}
//
// Aggregation rules:
//   - "evaluable" rules = verdict != EXCLUDED
//   - overall_score = n_concordant / n_evaluable (NaN-safe: 0 when
//     n_evaluable === 0)
//   - by_attribution counts NON_CONCORDANT verdicts by their
//     attribution category
//   - canonical answers used = reviewer-sourced when present, agent
//     otherwise (matches the DECIDE leaderboard logic)
//
// Aligns with the ACCR design's "Summary level — composite adherence
// scores per domain and overall, with confidence intervals".
// Confidence intervals are 95% Wilson score on the per-patient ratios.

import fs from "node:fs";
import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { pathFor } from "@chart-review/storage";
import { getPilotManifest } from "./lib/domain/iter/index.js";
import { getRunManifest, getRunStatus } from "./lib/infra/batch-run/index.js";
import type { RuleVerdict, AttributionCategory } from "@chart-review/platform-types";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

interface PerRuleRow {
  rule_id: string;
  verdict: RuleVerdict["verdict"];
  attribution?: AttributionCategory;
  source?: string;
}

interface PerPatientSummary {
  patient_id: string;
  n_total_rules: number;
  n_evaluable: number;
  n_concordant: number;
  n_non_concordant: number;
  n_excluded: number;
  overall_score: number;
  /** 95% Wilson CI on overall_score; null when n_evaluable < 1. */
  ci_95: [number, number] | null;
  by_attribution: Record<string, number>;
  by_rule: PerRuleRow[];
}

interface CohortSummary {
  ok: true;
  task_id: string;
  iter_id: string;
  n_patients: number;
  cohort: {
    n_evaluable_total: number;
    n_concordant_total: number;
    overall_score: number;
    ci_95: [number, number] | null;
    by_attribution: Record<string, number>;
  };
  by_patient: PerPatientSummary[];
}

/** Wilson 95% score interval. Returns null when n < 1. */
function wilson95(k: number, n: number): [number, number] | null {
  if (n < 1) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const half = z * Math.sqrt(p * (1 - p) / n + (z * z) / (4 * n * n));
  return [
    Math.max(0, (center - half) / denom),
    Math.min(1, (center + half) / denom),
  ];
}

function readPatientVerdicts(sessionId: string, pid: string, taskId: string): PerRuleRow[] {
  const fp = pathFor.reviewState(sessionId, pid, taskId);
  if (!fs.existsSync(fp)) return [];
  try {
    const rs = JSON.parse(fs.readFileSync(fp, "utf8")) as {
      rule_verdicts?: RuleVerdict[];
    };
    // Canonical view: reviewer wins per rule_id, agent otherwise.
    const byRid = new Map<string, RuleVerdict>();
    for (const v of rs.rule_verdicts ?? []) {
      const prior = byRid.get(v.rule_id);
      if (!prior || (v.source === "reviewer" && prior.source !== "reviewer")) {
        byRid.set(v.rule_id, v);
      }
    }
    return [...byRid.values()].map((v) => ({
      rule_id: v.rule_id,
      verdict: v.verdict,
      attribution: v.attribution,
      source: v.source,
    }));
  } catch {
    return [];
  }
}

function summarizePatient(pid: string, rows: PerRuleRow[]): PerPatientSummary {
  const byAttribution: Record<string, number> = {};
  let nConc = 0, nNon = 0, nExc = 0;
  for (const r of rows) {
    if (r.verdict === "CONCORDANT") nConc++;
    else if (r.verdict === "EXCLUDED") nExc++;
    else {
      nNon++;
      const key = r.attribution ?? "UNATTRIBUTED";
      byAttribution[key] = (byAttribution[key] ?? 0) + 1;
    }
  }
  const evaluable = nConc + nNon;
  const overall = evaluable > 0 ? nConc / evaluable : 0;
  return {
    patient_id: pid,
    n_total_rules: rows.length,
    n_evaluable: evaluable,
    n_concordant: nConc,
    n_non_concordant: nNon,
    n_excluded: nExc,
    overall_score: overall,
    ci_95: wilson95(nConc, evaluable),
    by_attribution: byAttribution,
    by_rule: rows,
  };
}

export const adherenceSummaryRoutes: RouteEntry[] = [
  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId/adherence-summary",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      if (task.task_kind !== "adherence") {
        throw httpErr(400, `task ${p.taskId} is not adherence (task_kind=${task.task_kind ?? "phenotype"})`);
      }
      const pilot = getPilotManifest(p.taskId, p.iterId);
      if (!pilot) throw httpErr(404, `pilot ${p.iterId} not found`);
      // The iteration pins exactly one session. A legacy iter with no
      // session_id reads NOTHING — empty patient list, empty summary —
      // rather than falling back to the flat review_state path.
      const sessionId = pilot.session_id;
      const run = getRunManifest(pilot.run_id);
      const status = getRunStatus(pilot.run_id);
      const patientIds: string[] = sessionId
        ? (run?.patient_ids
           ?? (status?.per_patient ? Object.keys(status.per_patient) : []))
        : [];

      const byPatient: PerPatientSummary[] = patientIds.map((pid) =>
        summarizePatient(pid, readPatientVerdicts(sessionId!, pid, p.taskId)),
      );

      const cohortEvaluable = byPatient.reduce((n, s) => n + s.n_evaluable, 0);
      const cohortConcordant = byPatient.reduce((n, s) => n + s.n_concordant, 0);
      const cohortAttrib: Record<string, number> = {};
      for (const s of byPatient) {
        for (const [k, v] of Object.entries(s.by_attribution)) {
          cohortAttrib[k] = (cohortAttrib[k] ?? 0) + v;
        }
      }

      const body: CohortSummary = {
        ok: true,
        task_id: p.taskId,
        iter_id: p.iterId,
        n_patients: patientIds.length,
        cohort: {
          n_evaluable_total: cohortEvaluable,
          n_concordant_total: cohortConcordant,
          overall_score: cohortEvaluable > 0 ? cohortConcordant / cohortEvaluable : 0,
          ci_95: wilson95(cohortConcordant, cohortEvaluable),
          by_attribution: cohortAttrib,
        },
        by_patient: byPatient,
      };
      return body;
    },
  },

  {
    method: "GET", pattern: "/api/pilots/:taskId/:iterId/adherence-summary/:patientId",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      if (task.task_kind !== "adherence") {
        throw httpErr(400, `task ${p.taskId} is not adherence`);
      }
      const pilot = getPilotManifest(p.taskId, p.iterId);
      if (!pilot) throw httpErr(404, `pilot ${p.iterId} not found`);
      // Iter pins one session; legacy iter (no session_id) reads NOTHING.
      const sessionId = pilot.session_id;
      const rows = sessionId
        ? readPatientVerdicts(sessionId, p.patientId, p.taskId)
        : [];
      return { ok: true, ...summarizePatient(p.patientId, rows) };
    },
  },
];
