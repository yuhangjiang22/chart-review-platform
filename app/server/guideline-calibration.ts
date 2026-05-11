/**
 * Guideline-calibration driver — deterministic v1.
 *
 * Pre-lock validation: walk the guideline's criteria, replay reviewer answers
 * from audit logs, compute Cohen's κ per criterion via kappa.ts, write a
 * report.
 *
 *   guideline + reviews/  →  calibration/<guideline-id>/<run-id>/{raw.json, report.md}
 *
 * Unlike the other verb-skill drivers, this v1 does NOT invoke an agent —
 * the κ math is deterministic and the disagreement listing is mechanical.
 * A phase-2 layer can wrap an agent invocation around this output to
 * generate a qualitative "Observations" section in the report (the
 * `chart-review-calibrate` skill describes what that would do).
 */

import fs from "fs";
import path from "path";
import { PLATFORM_ROOT } from "./patients.js";
import { loadCompiledTask } from "./tasks.js";
import {
  replayReviewerAnswers,
  computeKappaProper,
  type KappaResult,
} from "./kappa.js";

const CALIBRATION_ROOT = path.join(PLATFORM_ROOT, "var", "calibration");

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

export type KappaBucket = "excellent" | "acceptable" | "weak" | "poor" | "low_n";

function bucketFor(k: number, n: number, minShared: number): KappaBucket {
  if (n < minShared) return "low_n";
  if (k >= 0.8) return "excellent";
  if (k >= 0.6) return "acceptable";
  if (k >= 0.4) return "weak";
  return "poor";
}

export interface CriterionCalibration {
  field_id: string;
  group?: string;
  has_kappa: boolean;
  kappa?: number;
  weighted_kappa_linear?: number;
  weighted_kappa_quadratic?: number;
  percent_agreement?: number;
  kappa_ci_95?: [number, number];
  reviewers?: [string, string];
  n_shared?: number;
  confusion?: Record<string, Record<string, number>>;
  bucket: KappaBucket;
  note?: string;
}

export interface CalibrationResult {
  ok: boolean;
  guideline_id: string;
  run_id: string;
  output_dir: string;
  raw_path: string;
  report_path: string;
  total_criteria: number;
  criteria_calibrated: number;
  buckets: Record<KappaBucket, number>;
  recommendation: "ready_to_lock" | "revise_then_recalibrate" | "insufficient_data";
  per_criterion: CriterionCalibration[];
  duration_ms: number;
  error?: string;
}

export interface CalibrateOptions {
  guideline_id: string;
  /** Optional run id; defaults to a timestamp. */
  run_id?: string;
  /** Optional κ threshold below which the recommendation is to revise. Default 0.7. */
  kappa_threshold?: number;
  /** Optional minimum n_shared for κ to be considered reliable. Default 10. */
  min_shared?: number;
}

export async function calibrateGuideline(
  opts: CalibrateOptions,
): Promise<CalibrationResult> {
  const startedAt = Date.now();
  const threshold = opts.kappa_threshold ?? 0.7;
  const minShared = opts.min_shared ?? 10;

  const task = loadCompiledTask(opts.guideline_id);
  if (!task) {
    return {
      ok: false,
      guideline_id: opts.guideline_id,
      run_id: "",
      output_dir: "",
      raw_path: "",
      report_path: "",
      total_criteria: 0,
      criteria_calibrated: 0,
      buckets: { excellent: 0, acceptable: 0, weak: 0, poor: 0, low_n: 0 },
      recommendation: "insufficient_data",
      per_criterion: [],
      duration_ms: 0,
      error: `guideline not found: ${opts.guideline_id}`,
    };
  }

  const runId =
    opts.run_id ?? new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(CALIBRATION_ROOT, opts.guideline_id, runId);
  fs.mkdirSync(outDir, { recursive: true });

  // Skip derived fields — κ on derivations is mechanical and meaningless.
  const leafFields = (task.fields ?? []).filter(
    (f: any) => !f.derivation,
  );

  const perCriterion: CriterionCalibration[] = [];
  const buckets: Record<KappaBucket, number> = {
    excellent: 0,
    acceptable: 0,
    weak: 0,
    poor: 0,
    low_n: 0,
  };

  for (const f of leafFields) {
    const fieldId = (f as any).id as string;
    const group = (f as any).group as string | undefined;

    const replayed = replayReviewerAnswers(
      reviewsRoot(),
      opts.guideline_id,
      fieldId,
    );

    if (replayed.length === 0) {
      const entry: CriterionCalibration = {
        field_id: fieldId,
        group,
        has_kappa: false,
        bucket: "low_n",
        note: "no reviewer assessments replayed for this field",
      };
      perCriterion.push(entry);
      buckets.low_n += 1;
      continue;
    }

    // Detect ordinal categories from the criterion's answer_schema.enum if
    // the field author marked the field as ordinal (`ordinal: true` in the
    // YAML). We don't auto-assume enum order = rank order; the author opts in.
    const fieldYaml = f as { ordinal?: boolean; answer_schema?: { enum?: string[] } };
    const ordinal_categories =
      fieldYaml.ordinal === true && Array.isArray(fieldYaml.answer_schema?.enum)
        ? fieldYaml.answer_schema!.enum.map(String)
        : undefined;

    const k: KappaResult | null = computeKappaProper(replayed, { ordinal_categories });
    if (!k) {
      const entry: CriterionCalibration = {
        field_id: fieldId,
        group,
        has_kappa: false,
        bucket: "low_n",
        note: "fewer than 2 reviewers OR fewer than 10 shared records",
      };
      perCriterion.push(entry);
      buckets.low_n += 1;
      continue;
    }

    const bucket = bucketFor(k.kappa, k.kappa_n_shared, minShared);
    perCriterion.push({
      field_id: fieldId,
      group,
      has_kappa: true,
      kappa: k.kappa,
      weighted_kappa_linear: k.weighted_kappa_linear,
      weighted_kappa_quadratic: k.weighted_kappa_quadratic,
      percent_agreement: k.percent_agreement,
      kappa_ci_95: k.kappa_ci_95,
      reviewers: k.kappa_reviewers,
      n_shared: k.kappa_n_shared,
      confusion: k.confusion,
      bucket,
    });
    buckets[bucket] += 1;
  }

  const calibrated = perCriterion.filter((c) => c.has_kappa).length;
  const failingCriteria = perCriterion.filter(
    (c) => c.has_kappa && (c.kappa as number) < threshold,
  );
  let recommendation: CalibrationResult["recommendation"];
  if (calibrated === 0) recommendation = "insufficient_data";
  else if (failingCriteria.length > 0) recommendation = "revise_then_recalibrate";
  else recommendation = "ready_to_lock";

  const raw = {
    guideline_id: opts.guideline_id,
    run_id: runId,
    started_at: new Date(startedAt).toISOString(),
    completed_at: new Date().toISOString(),
    kappa_threshold: threshold,
    min_shared: minShared,
    total_criteria: leafFields.length,
    criteria_calibrated: calibrated,
    buckets,
    recommendation,
    per_criterion: perCriterion,
  };
  const rawPath = path.join(outDir, "raw.json");
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));

  const reportPath = path.join(outDir, "report.md");
  fs.writeFileSync(reportPath, renderReport(raw));

  return {
    ok: true,
    guideline_id: opts.guideline_id,
    run_id: runId,
    output_dir: outDir,
    raw_path: rawPath,
    report_path: reportPath,
    total_criteria: leafFields.length,
    criteria_calibrated: calibrated,
    buckets,
    recommendation,
    per_criterion: perCriterion,
    duration_ms: Date.now() - startedAt,
  };
}

function renderReport(raw: ReturnType<typeof identity>): string {
  const lines: string[] = [];
  lines.push(`# Calibration report: ${raw.guideline_id} @ ${raw.run_id}`);
  lines.push("");
  lines.push(`- Started: ${raw.started_at}`);
  lines.push(`- κ threshold: ${raw.kappa_threshold}`);
  lines.push(`- Min n_shared: ${raw.min_shared}`);
  lines.push(`- Total leaf criteria: ${raw.total_criteria}`);
  lines.push(`- Criteria with computable κ: ${raw.criteria_calibrated}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- excellent (κ ≥ 0.8): ${raw.buckets.excellent}`);
  lines.push(`- acceptable (0.6 ≤ κ < 0.8): ${raw.buckets.acceptable}`);
  lines.push(`- weak (0.4 ≤ κ < 0.6): ${raw.buckets.weak}`);
  lines.push(`- poor (κ < 0.4): ${raw.buckets.poor}`);
  lines.push(`- low n / no data: ${raw.buckets.low_n}`);
  lines.push("");
  lines.push(`**Recommendation:** ${raw.recommendation.replace(/_/g, " ")}`);
  lines.push("");
  lines.push("## Per-criterion statistics");
  lines.push("");
  lines.push("| criterion | group | n | κ | 95% CI | weighted κ (lin) | weighted κ (quad) | % agreement | bucket | note |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of raw.per_criterion) {
    const k = c.has_kappa && c.kappa != null ? (c.kappa as number).toFixed(3) : "—";
    const ci =
      c.has_kappa && c.kappa_ci_95
        ? `[${c.kappa_ci_95[0].toFixed(2)}, ${c.kappa_ci_95[1].toFixed(2)}]`
        : "—";
    const wkLin =
      c.has_kappa && c.weighted_kappa_linear != null
        ? (c.weighted_kappa_linear as number).toFixed(3)
        : "—";
    const wkQuad =
      c.has_kappa && c.weighted_kappa_quadratic != null
        ? (c.weighted_kappa_quadratic as number).toFixed(3)
        : "—";
    const pa =
      c.has_kappa && c.percent_agreement != null
        ? `${((c.percent_agreement as number) * 100).toFixed(1)}%`
        : "—";
    const n = c.has_kappa ? String(c.n_shared) : "—";
    const note = c.note ?? "";
    lines.push(
      `| ${c.field_id} | ${c.group ?? ""} | ${n} | ${k} | ${ci} | ${wkLin} | ${wkQuad} | ${pa} | ${c.bucket} | ${note} |`,
    );
  }

  // Surface confusion matrices for criteria that need work
  const needsWork = raw.per_criterion.filter(
    (c) => c.has_kappa && (c.kappa as number) < raw.kappa_threshold,
  );
  if (needsWork.length > 0) {
    lines.push("");
    lines.push(`## Criteria needing work (κ < ${raw.kappa_threshold})`);
    for (const c of needsWork) {
      lines.push("");
      lines.push(`### ${c.field_id} (κ = ${(c.kappa as number).toFixed(3)})`);
      lines.push("");
      const cats = Object.keys(c.confusion ?? {}).sort();
      const allCats = new Set<string>();
      for (const a of cats) for (const b of Object.keys((c.confusion as any)[a])) allCats.add(b);
      const colCats = [...allCats].sort();
      lines.push("Confusion (rows = " + (c.reviewers?.[0] ?? "A") + ", cols = " + (c.reviewers?.[1] ?? "B") + "):");
      lines.push("");
      lines.push(`| | ${colCats.map((x) => `B: ${x}`).join(" | ")} |`);
      lines.push(`|---|${colCats.map(() => "---").join("|")}|`);
      for (const a of cats) {
        const row = colCats.map(
          (b) => String(((c.confusion as any)[a]?.[b] as number) ?? 0),
        );
        lines.push(`| A: ${a} | ${row.join(" | ")} |`);
      }
    }
    lines.push("");
    lines.push(
      "Recommended next step: run `chart-review-improve` on the disagreement clusters above.",
    );
  } else if (raw.criteria_calibrated > 0) {
    lines.push("");
    lines.push("All calibrated criteria meet the threshold. Ready to lock.");
  }

  return lines.join("\n") + "\n";
}

// Type helper used by renderReport — same shape as the `raw` object above.
function identity(): {
  guideline_id: string;
  run_id: string;
  started_at: string;
  kappa_threshold: number;
  min_shared: number;
  total_criteria: number;
  criteria_calibrated: number;
  buckets: Record<KappaBucket, number>;
  recommendation: CalibrationResult["recommendation"];
  per_criterion: CriterionCalibration[];
} {
  throw new Error("type-only helper");
}
