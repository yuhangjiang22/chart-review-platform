/**
 * Reproducibility bundle export.
 *
 * Bundles everything a paper submission would need into a single dir
 * at exports/<task_id>/<ISO ts>/:
 *
 *   guideline/             full guideline package at current SHA
 *   reviews/<pid>/         review_state.json files locked at that SHA
 *   cohort_feedback/       every cohort feedback run (Role C drift surface)
 *   methods/               every Methods draft (run-keyed)
 *   rules/                 every rule proposal (any status)
 *   runs/<run_id>/         agent batch run manifest + status
 *   pilots/                already inside guideline/, count surfaced
 *   deployment_cohorts/    deployment-validation cohorts: manifests + samples
 *                          + reviewer validations + deployment-κ reports
 *                          (blueprint blocks 5 + 6)
 *   deployment_issues/     append-only issue log for THIS guideline_sha
 *   manifest.json          provenance + counts
 *   README.md              human summary
 *
 * Methodologist-only. Tarball/zip packaging is a follow-up — for v1,
 * the bundle is a directory that the user can tar/zip themselves.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { execSync } from "child_process";
import { PLATFORM_ROOT } from "../../patients.js";
import { guidelineDir, loadSkillBundle } from "../rubric/index.js";
import { computeTaskSha } from "../../lock.js";
import { replayReviewerAnswers, computeKappaProper } from "../../kappa.js";
import { deploymentIssuesRoot } from "../issue/index.js";

export interface ExportContents {
  guideline: boolean;
  reviews: { count: number };
  cohort_feedback: { run_count: number };
  methods: { run_count: number };
  rules: { count: number };
  runs: { count: number };
  pilots: { count: number };
  statistics: { n_fields: number; n_with_kappa: number };
  /** Deployment-validation cohorts keyed to this task: manifests + samples
   *  + reviewer validations + deployment-κ reports. Required by blueprint
   *  block 5 + 6 in the methods section. */
  deployment_cohorts: {
    cohort_count: number;
    sample_count: number;
    validation_count: number;
    report_count: number;
  };
  /** Append-only issue log filed against the locked guideline_sha. */
  deployment_issues: { count: number };
}

export interface BundleStatistics {
  task_id: string;
  guideline_sha: string;
  generated_at: string;
  n_locked: number;
  n_reviewers: number;
  reviewers: string[];
  per_field: Array<{
    field_id: string;
    n: number;
    n_shared?: number;
    kappa?: number;
    kappa_ci_95?: [number, number];
    weighted_kappa_linear?: number;
    weighted_kappa_quadratic?: number;
    percent_agreement?: number;
    note?: string;
  }>;
}

export interface ExportManifest {
  task_id: string;
  bundle_id: string;
  exported_at: string;
  exported_by: string;
  guideline_sha: string;
  git_commit?: string;
  contents: ExportContents;
}

export interface ExportListing {
  task_id: string;
  bundle_id: string;
  exported_at: string;
  exported_by?: string;
  guideline_sha?: string;
}

export function exportsRoot(): string {
  return process.env.CHART_REVIEW_EXPORTS_ROOT ?? path.join(PLATFORM_ROOT, "exports");
}
function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "reviews");
}
function cohortsRoot(): string {
  return process.env.CHART_REVIEW_COHORTS_ROOT ?? path.join(PLATFORM_ROOT, "cohorts");
}
function methodsRootDir(): string {
  return process.env.CHART_REVIEW_METHODS_ROOT ?? path.join(PLATFORM_ROOT, "methods");
}
function proposalsRoot(): string {
  return process.env.CHART_REVIEW_PROPOSALS_ROOT ?? path.join(PLATFORM_ROOT, "proposals");
}
function runsRootDir(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(PLATFORM_ROOT, "runs");
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function tryGitCommit(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: PLATFORM_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export interface ExportBundleResult {
  ok: boolean;
  bundle_dir?: string;
  /** Path to the .tar.gz archive of the bundle, when {tarball: true}. */
  tarball_path?: string;
  /** Bytes of the .tar.gz, useful for the UI's "(12 MB)" display. */
  tarball_size?: number;
  manifest?: ExportManifest;
  error?: string;
}

export function exportBundle(opts: {
  task_id: string;
  exported_by: string;
  /** #48 — also produce a .tar.gz next to the directory so the bundle can
   *  be shipped as a single file (lab archives, regulatory submissions). */
  tarball?: boolean;
}): ExportBundleResult {
  const { task_id: taskId, exported_by } = opts;
  const guidelinePath = guidelineDir(taskId);
  if (!fs.existsSync(path.join(guidelinePath, "meta.yaml"))) {
    return { ok: false, error: `guideline ${taskId} not found at ${guidelinePath}` };
  }
  const guidelineSha = computeTaskSha(guidelinePath);
  const exportedAt = new Date().toISOString();
  const bundleId = exportedAt.replace(/[:.]/g, "-");
  const bundleDir = path.join(exportsRoot(), taskId, bundleId);
  fs.mkdirSync(bundleDir, { recursive: true });

  // 1. guideline/  (includes pilots/ since that lives inside the guideline)
  copyDirRecursive(guidelinePath, path.join(bundleDir, "guideline"));

  // 2. reviews/ — only locks at this SHA
  let reviewCount = 0;
  const rRoot = reviewsRoot();
  if (fs.existsSync(rRoot)) {
    for (const pid of fs.readdirSync(rRoot)) {
      if (pid.startsWith("_") || pid.startsWith(".")) continue;
      const rsPath = path.join(rRoot, pid, taskId, "review_state.json");
      if (!fs.existsSync(rsPath)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(rsPath, "utf8")) as { lock_task_sha?: string };
        if (j.lock_task_sha !== guidelineSha) continue;
        const dst = path.join(bundleDir, "reviews", pid);
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(rsPath, path.join(dst, "review_state.json"));
        reviewCount++;
      } catch {
        /* skip unreadable */
      }
    }
  }

  // 3. cohort_feedback/  (every run)
  let cohortRunCount = 0;
  const cohortRunsDir = path.join(cohortsRoot(), taskId, "runs");
  if (fs.existsSync(cohortRunsDir)) {
    copyDirRecursive(cohortRunsDir, path.join(bundleDir, "cohort_feedback"));
    cohortRunCount = fs.readdirSync(cohortRunsDir).filter((n) => !n.startsWith(".")).length;
  }

  // 4. methods/  (every draft)
  let methodsRunCount = 0;
  const methodsTaskDir = path.join(methodsRootDir(), taskId);
  if (fs.existsSync(methodsTaskDir)) {
    copyDirRecursive(methodsTaskDir, path.join(bundleDir, "methods"));
    methodsRunCount = fs.readdirSync(methodsTaskDir).filter((n) => !n.startsWith(".")).length;
  }

  // 5. rules/ (every proposal — accepted, rejected, applied, draft)
  let ruleCount = 0;
  const proposalsDir = path.join(proposalsRoot(), taskId);
  if (fs.existsSync(proposalsDir)) {
    copyDirRecursive(proposalsDir, path.join(bundleDir, "rules"));
    try {
      ruleCount = fs.readdirSync(proposalsDir).filter((n) => !n.startsWith(".")).length;
    } catch {
      ruleCount = 0;
    }
  }

  // 6. runs/<run_id>/{manifest,status}.json — drafts excluded (too heavy)
  let runCount = 0;
  const runsDir = runsRootDir();
  if (fs.existsSync(runsDir)) {
    for (const rid of fs.readdirSync(runsDir)) {
      if (rid.startsWith("_") || rid.startsWith(".")) continue;
      const mf = path.join(runsDir, rid, "manifest.json");
      if (!fs.existsSync(mf)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(mf, "utf8")) as { task_id?: string };
        if (m.task_id !== taskId) continue;
        const dst = path.join(bundleDir, "runs", rid);
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(mf, path.join(dst, "manifest.json"));
        const st = path.join(runsDir, rid, "status.json");
        if (fs.existsSync(st)) fs.copyFileSync(st, path.join(dst, "status.json"));
        runCount++;
      } catch {
        /* skip */
      }
    }
  }

  // 7. pilots count — already inside guideline/pilots/
  let pilotCount = 0;
  const pilotsDir = path.join(guidelinePath, "pilots");
  if (fs.existsSync(pilotsDir)) {
    pilotCount = fs.readdirSync(pilotsDir).filter((n) => /^iter_\d+$/.test(n)).length;
  }

  // 7b. deployment_cohorts/<cohort_id>/ — manifests, sample selections,
  //     reviewer validations, deployment-κ reports. These bind blocks 5+6 of
  //     the methods section to a reproducible artifact. Includes only cohorts
  //     whose task_id matches this export's task — same filter as runs.
  const deployment = _collectDeploymentCohorts(taskId, bundleDir);

  // 7c. deployment_issues/<sha>.jsonl — the production-issue queue filed
  //     against THIS guideline_sha (not other shas of the same task).
  const issuesCount = _collectDeploymentIssues(guidelineSha, bundleDir);

  // 8. statistics.json — computed κ, weighted κ, % agreement, CI per field
  // across the locked review_state files we just bundled. Without this the
  // bundle is data without conclusions; the Methods drafter has nothing to
  // cite.
  const stats = computeBundleStatistics(taskId, guidelineSha, exportedAt, rRoot);
  fs.writeFileSync(
    path.join(bundleDir, "statistics.json"),
    JSON.stringify(stats, null, 2),
  );
  fs.writeFileSync(
    path.join(bundleDir, "statistics.md"),
    renderStatistics(stats),
  );

  const manifest: ExportManifest = {
    task_id: taskId,
    bundle_id: bundleId,
    exported_at: exportedAt,
    exported_by,
    guideline_sha: guidelineSha,
    git_commit: tryGitCommit(),
    contents: {
      guideline: true,
      reviews: { count: reviewCount },
      cohort_feedback: { run_count: cohortRunCount },
      methods: { run_count: methodsRunCount },
      rules: { count: ruleCount },
      runs: { count: runCount },
      pilots: { count: pilotCount },
      statistics: {
        n_fields: stats.per_field.length,
        n_with_kappa: stats.per_field.filter((f) => f.kappa != null).length,
      },
      deployment_cohorts: deployment,
      deployment_issues: { count: issuesCount },
    },
  };
  fs.writeFileSync(path.join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(bundleDir, "README.md"), renderReadme(manifest));

  let tarballPath: string | undefined;
  let tarballSize: number | undefined;
  if (opts.tarball) {
    try {
      tarballPath = makeTarball(bundleDir);
      tarballSize = fs.statSync(tarballPath).size;
    } catch (e) {
      console.error(`[bundle-export] tarball failed for ${bundleId}: ${(e as Error).message}`);
    }
  }

  return {
    ok: true,
    bundle_dir: bundleDir,
    tarball_path: tarballPath,
    tarball_size: tarballSize,
    manifest,
  };
}

/** #48 — wrap a bundle directory into <bundle_id>.tar.gz placed next to it.
 *  Uses the system `tar` (BSD/GNU compatible flags) to avoid an extra npm
 *  dependency. The archive's top-level entry is the bundle_id directory so
 *  unpacking is clean: `tar xzf bundle.tar.gz` recreates the original tree. */
export function makeTarball(bundleDir: string): string {
  const parent = path.dirname(bundleDir);
  const base = path.basename(bundleDir);
  const archive = path.join(parent, `${base}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", parent, base], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  return archive;
}

function renderReadme(m: ExportManifest): string {
  const c = m.contents;
  return `# Reproducibility bundle: ${m.task_id}

Exported at ${m.exported_at} by ${m.exported_by}.

- guideline_sha: ${m.guideline_sha}
- git_commit: ${m.git_commit ?? "(unknown)"}

## Contents

- \`guideline/\` — full guideline package at the SHA above (incl. pilots/)
- \`reviews/<patient_id>/review_state.json\` — locks at this SHA only (n=${c.reviews.count})
- \`cohort_feedback/\` — every Role C run for this task (n=${c.cohort_feedback.run_count})
- \`methods/\` — Methods draft history (n=${c.methods.run_count})
- \`rules/\` — every rule proposal across all statuses (n=${c.rules.count})
- \`runs/<run_id>/{manifest,status}.json\` — agent batch runs scoped to this task (n=${c.runs.count}; per-patient drafts not included)
- pilot iterations included via guideline/pilots/ (n=${c.pilots.count})
- \`statistics.json\` + \`statistics.md\` — per-field κ, weighted κ, percent agreement, 95% bootstrap CI computed from the locked review_state files (${c.statistics.n_with_kappa}/${c.statistics.n_fields} fields with computable κ)
- \`deployment_cohorts/<cohort_id>/\` — deployment-validation surface for blocks 5+6 of the methods section: cohort manifests (n=${c.deployment_cohorts.cohort_count}), stratified sample selections (n=${c.deployment_cohorts.sample_count}), reviewer validations (n=${c.deployment_cohorts.validation_count}), deployment-κ reports (n=${c.deployment_cohorts.report_count})
- \`deployment_issues/<sha>.jsonl\` — production-issue log filed against this guideline_sha (n=${c.deployment_issues.count})
`;
}

// ── statistics helpers (#41) ─────────────────────────────────────────────────

function computeBundleStatistics(
  taskId: string,
  guidelineSha: string,
  generatedAt: string,
  reviewsRootPath: string,
): BundleStatistics {
  // Identify the field list and ordinal flags from the live guideline.
  let fields: Array<{ id: string; ordinal?: boolean; answer_schema?: { enum?: string[] } }> = [];
  try {
    const task = loadSkillBundle(taskId);
    fields = (task.fields ?? []) as Array<{ id: string; ordinal?: boolean; answer_schema?: { enum?: string[] } }>;
  } catch {
    /* missing guideline — leave empty */
  }

  // Collect every reviewer who has a lock at this SHA on this task.
  const reviewers = new Set<string>();
  let nLocked = 0;
  if (fs.existsSync(reviewsRootPath)) {
    for (const pid of fs.readdirSync(reviewsRootPath)) {
      const rsPath = path.join(reviewsRootPath, pid, taskId, "review_state.json");
      if (!fs.existsSync(rsPath)) continue;
      try {
        const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
          lock_task_sha?: string;
          field_assessments?: Array<{ updated_by?: string; source?: string }>;
        };
        if (rs.lock_task_sha !== guidelineSha) continue;
        nLocked++;
        for (const fa of rs.field_assessments ?? []) {
          if (fa.source === "reviewer" && fa.updated_by) reviewers.add(fa.updated_by);
        }
      } catch {
        /* skip */
      }
    }
  }

  const perField: BundleStatistics["per_field"] = fields.map((f) => {
    const replayed = replayReviewerAnswers(reviewsRootPath, taskId, f.id);
    if (replayed.length === 0) {
      return { field_id: f.id, n: 0, note: "no reviewer assessments" };
    }
    const ordinal_categories =
      f.ordinal === true && Array.isArray(f.answer_schema?.enum)
        ? f.answer_schema!.enum.map(String)
        : undefined;
    const k = computeKappaProper(replayed, { ordinal_categories });
    if (!k) {
      return {
        field_id: f.id,
        n: replayed.length,
        note: "fewer than 2 reviewers OR fewer than 10 shared records",
      };
    }
    return {
      field_id: f.id,
      n: replayed.length,
      n_shared: k.kappa_n_shared,
      kappa: k.kappa,
      kappa_ci_95: k.kappa_ci_95,
      weighted_kappa_linear: k.weighted_kappa_linear,
      weighted_kappa_quadratic: k.weighted_kappa_quadratic,
      percent_agreement: k.percent_agreement,
    };
  });

  return {
    task_id: taskId,
    guideline_sha: guidelineSha,
    generated_at: generatedAt,
    n_locked: nLocked,
    n_reviewers: reviewers.size,
    reviewers: [...reviewers].sort(),
    per_field: perField,
  };
}

function renderStatistics(s: BundleStatistics): string {
  const lines: string[] = [];
  lines.push(`# Statistics: ${s.task_id}`);
  lines.push("");
  lines.push(`Generated: ${s.generated_at}`);
  lines.push(`Guideline SHA: ${s.guideline_sha}`);
  lines.push(`Locked records at this SHA: ${s.n_locked}`);
  lines.push(`Distinct reviewers: ${s.n_reviewers} (${s.reviewers.join(", ") || "—"})`);
  lines.push("");
  lines.push("## Per-field agreement");
  lines.push("");
  lines.push("| field | n | n_shared | κ | 95% CI | weighted κ (lin) | weighted κ (quad) | % agreement |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const f of s.per_field) {
    const k = f.kappa != null ? f.kappa.toFixed(3) : "—";
    const ci = f.kappa_ci_95 ? `[${f.kappa_ci_95[0].toFixed(2)}, ${f.kappa_ci_95[1].toFixed(2)}]` : "—";
    const wkLin = f.weighted_kappa_linear != null ? f.weighted_kappa_linear.toFixed(3) : "—";
    const wkQuad = f.weighted_kappa_quadratic != null ? f.weighted_kappa_quadratic.toFixed(3) : "—";
    const pa = f.percent_agreement != null ? `${(f.percent_agreement * 100).toFixed(1)}%` : "—";
    const nShared = f.n_shared != null ? String(f.n_shared) : "—";
    lines.push(
      `| ${f.field_id} | ${f.n} | ${nShared} | ${k} | ${ci} | ${wkLin} | ${wkQuad} | ${pa} |`,
    );
  }
  return lines.join("\n") + "\n";
}

export function listExports(taskId: string): ExportListing[] {
  const dir = path.join(exportsRoot(), taskId);
  if (!fs.existsSync(dir)) return [];
  const out: ExportListing[] = [];
  for (const bundleId of fs.readdirSync(dir)) {
    const mf = path.join(dir, bundleId, "manifest.json");
    if (!fs.existsSync(mf)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mf, "utf8")) as ExportManifest;
      out.push({
        task_id: taskId,
        bundle_id: m.bundle_id,
        exported_at: m.exported_at,
        exported_by: m.exported_by,
        guideline_sha: m.guideline_sha,
      });
    } catch {
      out.push({ task_id: taskId, bundle_id: bundleId, exported_at: bundleId });
    }
  }
  return out.sort((a, b) => b.exported_at.localeCompare(a.exported_at));
}

// ── Deployment-validation surface (blueprint §3 + §4) ────────────────────────

function deploymentCohortsRoot(): string {
  return process.env.CHART_REVIEW_COHORTS_ROOT ?? path.join(PLATFORM_ROOT, "cohorts");
}

// Use the canonical deploymentIssuesRoot from domain/issue (which respects
// CHART_REVIEW_PLATFORM_ROOT) instead of duplicating the path logic here.
const deploymentIssuesRootDir = deploymentIssuesRoot;

/**
 * Walk cohorts/ and bundle every cohort whose manifest.task_id matches the
 * exporting task. Each cohort contributes its manifest.json, every sample
 * selection, every per-patient reviewer validation, and every persisted
 * deployment-κ report.
 *
 * The bundle layout mirrors the runtime tree under deployment_cohorts/ so
 * downstream tools (the methods drafter, replication scripts) can find the
 * same files at the same relative paths they already expect.
 */
/**
 * Exported under an underscore-prefixed name so tests can drive these
 * collectors directly without seeding a full guideline + run + review fixture.
 * Internal callers still go through exportBundle.
 */
export function _collectDeploymentCohorts(
  taskId: string,
  bundleDir: string,
): { cohort_count: number; sample_count: number; validation_count: number; report_count: number } {
  const root = deploymentCohortsRoot();
  if (!fs.existsSync(root)) {
    return { cohort_count: 0, sample_count: 0, validation_count: 0, report_count: 0 };
  }

  let cohortCount = 0;
  let sampleCount = 0;
  let validationCount = 0;
  let reportCount = 0;

  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    const cohortDir = path.join(root, entry);
    const manifestPath = path.join(cohortDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest: { task_id?: string };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (manifest.task_id !== taskId) continue;

    const dst = path.join(bundleDir, "deployment_cohorts", entry);
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(manifestPath, path.join(dst, "manifest.json"));
    cohortCount++;

    // sample/selections/<run_id>.json
    const selectionsDir = path.join(cohortDir, "sample", "selections");
    if (fs.existsSync(selectionsDir)) {
      const dstSel = path.join(dst, "sample", "selections");
      fs.mkdirSync(dstSel, { recursive: true });
      for (const f of fs.readdirSync(selectionsDir)) {
        if (!f.endsWith(".json")) continue;
        fs.copyFileSync(path.join(selectionsDir, f), path.join(dstSel, f));
        sampleCount++;
      }
    }

    // sample/validations/<pid>/<task_id>/review_state.json
    const validationsDir = path.join(cohortDir, "sample", "validations");
    if (fs.existsSync(validationsDir)) {
      for (const pid of fs.readdirSync(validationsDir)) {
        if (pid.startsWith(".")) continue;
        const rsPath = path.join(validationsDir, pid, taskId, "review_state.json");
        if (!fs.existsSync(rsPath)) continue;
        const dstRs = path.join(dst, "sample", "validations", pid, taskId);
        fs.mkdirSync(dstRs, { recursive: true });
        fs.copyFileSync(rsPath, path.join(dstRs, "review_state.json"));
        validationCount++;
      }
    }

    // reports/<run_id>/deployment-kappa.{json,md}
    const reportsDir = path.join(cohortDir, "reports");
    if (fs.existsSync(reportsDir)) {
      for (const runId of fs.readdirSync(reportsDir)) {
        if (runId.startsWith(".")) continue;
        const reportRunDir = path.join(reportsDir, runId);
        const dstReport = path.join(dst, "reports", runId);
        let copied = false;
        for (const name of ["deployment-kappa.json", "deployment-kappa.md"]) {
          const src = path.join(reportRunDir, name);
          if (!fs.existsSync(src)) continue;
          if (!copied) fs.mkdirSync(dstReport, { recursive: true });
          fs.copyFileSync(src, path.join(dstReport, name));
          copied = true;
        }
        if (copied) reportCount++;
      }
    }
  }

  return { cohort_count: cohortCount, sample_count: sampleCount, validation_count: validationCount, report_count: reportCount };
}

/**
 * Bundle the deployment-issues log for this guideline_sha. Other shas' issues
 * stay out — the bundle is provenance for THIS lock, not the project's full
 * issue history.
 */
export function _collectDeploymentIssues(guidelineSha: string, bundleDir: string): number {
  const src = path.join(deploymentIssuesRootDir(), `${guidelineSha}.jsonl`);
  if (!fs.existsSync(src)) return 0;
  const dstDir = path.join(bundleDir, "deployment_issues");
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src, path.join(dstDir, `${guidelineSha}.jsonl`));
  // Count entries (each non-blank line is one log record).
  try {
    return fs.readFileSync(src, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}
