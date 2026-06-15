/**
 * kappa.ts — Inter-rater reliability (Cohen's κ) for reviewer answers.
 *
 * Two entry points:
 *   replayReviewerAnswers  — reconstruct (pid, reviewer, field, answer) tuples
 *                            from chat/<*>.jsonl audit logs (last-write-wins).
 *   computeKappaProper     — compute Cohen's κ for the 2 most-frequent
 *                            reviewers on shared patient records.
 */

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayedAnswer {
  patient_id: string;
  reviewer_id: string;
  field_id: string;
  answer: unknown;
  ts: string;
}

export interface KappaResult {
  kappa: number;
  /** Linear-weighted κ — only computed when ordinal_categories supplied. */
  weighted_kappa_linear?: number;
  /** Quadratic-weighted κ — only computed when ordinal_categories supplied. */
  weighted_kappa_quadratic?: number;
  /** Simple percent agreement (Po). */
  percent_agreement: number;
  /** 95% bootstrap CI on κ — present when bootstrap_n is supplied (default 1000). */
  kappa_ci_95?: [number, number];
  kappa_reviewers: [string, string];
  kappa_n_shared: number;
  confusion: Record<string, Record<string, number>>;
}

export interface ComputeKappaOptions {
  /** Ordered category list. When provided, enables weighted κ.
   *  E.g. ["I", "II", "III", "IV"] for cancer stage. */
  ordinal_categories?: string[];
  /** Number of bootstrap resamples for κ CI. Default 1000. Pass 0 to disable. */
  bootstrap_n?: number;
  /** RNG seed for reproducible bootstrap. Default 42. */
  bootstrap_seed?: number;
}

// ---------------------------------------------------------------------------
// replayReviewerAnswers
// ---------------------------------------------------------------------------

/**
 * Walk all `chat/<*>.jsonl` files under `reviewsRoot/<pid>/<taskId>/chat/` and
 * reconstruct (pid, reviewer, fieldId, answer, ts) tuples from ui_action
 * entries that match:
 *   step_type === "ui_action"
 *   action_type === "set_field_assessment"
 *   source === "reviewer"
 *   payload_field_id === fieldId
 *
 * Reviewer disambiguation: session_id must match `reviewer__<name>` (Phase B
 * Task 23 convention).  Entries that cannot be disambiguated are skipped.
 *
 * Last-write-wins per (patient_id, reviewer_id) key (ordered by `ts`).
 */
export function replayReviewerAnswers(
  reviewsRoot: string,
  taskId: string,
  fieldId: string,
): ReplayedAnswer[] {
  const latest = new Map<string, ReplayedAnswer>(); // key: `${pid}|${reviewerId}`

  if (!fs.existsSync(reviewsRoot)) return [];

  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const chatDir = path.join(reviewsRoot, pid, taskId, "chat");
    if (!fs.existsSync(chatDir)) continue;

    for (const fileName of fs.readdirSync(chatDir)) {
      if (!fileName.endsWith(".jsonl")) continue;
      const filePath = path.join(chatDir, fileName);
      const lines = fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .filter(Boolean);

      for (const line of lines) {
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // skip malformed lines
        }

        // Guard: must be a reviewer field-assessment action for this field
        if (
          entry.step_type !== "ui_action" ||
          entry.action_type !== "set_field_assessment" ||
          entry.source !== "reviewer" ||
          entry.payload_field_id !== fieldId ||
          typeof entry.ts !== "string"
        ) {
          continue;
        }

        // Disambiguate reviewer from session_id: must match `reviewer__<name>`
        const sessionId =
          typeof entry.session_id === "string" ? entry.session_id : "";
        const sessionMatch = sessionId.match(/^reviewer__(.+)$/);
        if (!sessionMatch) continue;
        const reviewerId = sessionMatch[1];

        const key = `${pid}|${reviewerId}`;
        const existing = latest.get(key);
        if (!existing || existing.ts < entry.ts) {
          latest.set(key, {
            patient_id: pid,
            reviewer_id: reviewerId,
            field_id: fieldId,
            answer: entry.payload_answer,
            ts: entry.ts,
          });
        }
      }
    }
  }

  return [...latest.values()];
}

// ---------------------------------------------------------------------------
// computeKappaProper
// ---------------------------------------------------------------------------

/**
 * Compute Cohen's κ for the 2 most-frequent reviewers in `answers`,
 * restricted to records (patient_ids) on which both reviewers have written.
 *
 * Returns null if:
 *   - fewer than 2 reviewers are present, or
 *   - the two most-frequent reviewers share fewer than 10 records.
 *
 * Edge case: when `1 - Pe == 0` (all answers are the same category), returns
 * κ = 1.0 (perfect agreement by convention).
 */
export function computeKappaProper(
  answers: ReplayedAnswer[],
  opts: ComputeKappaOptions = {},
): KappaResult | null {
  // Group by reviewer
  const byReviewer = new Map<string, ReplayedAnswer[]>();
  for (const a of answers) {
    const arr = byReviewer.get(a.reviewer_id) ?? [];
    arr.push(a);
    byReviewer.set(a.reviewer_id, arr);
  }

  if (byReviewer.size < 2) return null;

  // Pick the 2 most-frequent reviewers (by record count)
  const sorted = [...byReviewer.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );
  const [rA, rB] = [sorted[0][0], sorted[1][0]] as [string, string];

  // Index each reviewer's answers by patient_id (last-write-wins if duplicates)
  function indexByPid(
    rows: ReplayedAnswer[],
  ): Map<string, unknown> {
    const m = new Map<string, unknown>();
    for (const r of rows) {
      // If multiple entries exist for the same patient, keep the latest ts
      const existing = m.get(r.patient_id);
      if (existing === undefined) {
        m.set(r.patient_id, r.answer);
      } else {
        // rows may not be sorted; use a secondary map for ts tracking
        m.set(r.patient_id, r.answer); // safe: callers de-dup via replayReviewerAnswers
      }
    }
    return m;
  }

  const aByPid = indexByPid(byReviewer.get(rA)!);
  const bByPid = indexByPid(byReviewer.get(rB)!);

  // Find shared patients
  const sharedPids = [...aByPid.keys()].filter((p) => bByPid.has(p));
  if (sharedPids.length < 10) return null;

  const total = sharedPids.length;
  let agreements = 0;
  const confusion: Record<string, Record<string, number>> = {};
  const aCounts: Record<string, number> = {};
  const bCounts: Record<string, number> = {};

  for (const pid of sharedPids) {
    const a = String(aByPid.get(pid));
    const b = String(bByPid.get(pid));

    if (a === b) agreements++;

    // Confusion matrix: rows = rA's answer, cols = rB's answer
    if (!confusion[a]) confusion[a] = {};
    confusion[a][b] = (confusion[a][b] ?? 0) + 1;

    aCounts[a] = (aCounts[a] ?? 0) + 1;
    bCounts[b] = (bCounts[b] ?? 0) + 1;
  }

  const Po = agreements / total;

  // Expected agreement under independence
  const categories = new Set([
    ...Object.keys(aCounts),
    ...Object.keys(bCounts),
  ]);
  let Pe = 0;
  for (const c of categories) {
    Pe += ((aCounts[c] ?? 0) / total) * ((bCounts[c] ?? 0) / total);
  }

  const denom = 1 - Pe;
  const kappa = denom === 0 ? 1.0 : (Po - Pe) / denom;

  const result: KappaResult = {
    kappa,
    percent_agreement: Po,
    kappa_reviewers: [rA, rB],
    kappa_n_shared: total,
    confusion,
  };

  // Weighted κ — only meaningful when categories have a known ordinal ordering.
  if (opts.ordinal_categories && opts.ordinal_categories.length >= 2) {
    const linear = computeWeightedKappa(aCounts, bCounts, confusion, total, opts.ordinal_categories, "linear");
    const quad = computeWeightedKappa(aCounts, bCounts, confusion, total, opts.ordinal_categories, "quadratic");
    if (linear !== null) result.weighted_kappa_linear = linear;
    if (quad !== null) result.weighted_kappa_quadratic = quad;
  }

  // Bootstrap 95% CI on κ. Default 1000 resamples; opt-out with bootstrap_n=0.
  const bootstrapN = opts.bootstrap_n ?? 1000;
  if (bootstrapN > 0 && total >= 10) {
    // Build the per-pid (a, b) pair list once for fast resampling.
    const pairs: Array<[string, string]> = [];
    for (const pid of sharedPids) {
      pairs.push([String(aByPid.get(pid)), String(bByPid.get(pid))]);
    }
    const ci = bootstrapKappaCI(pairs, bootstrapN, opts.bootstrap_seed ?? 42);
    if (ci) result.kappa_ci_95 = ci;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Weighted κ + bootstrap helpers
// ---------------------------------------------------------------------------

function computeWeightedKappa(
  aCounts: Record<string, number>,
  bCounts: Record<string, number>,
  confusion: Record<string, Record<string, number>>,
  total: number,
  ordered: string[],
  scheme: "linear" | "quadratic",
): number | null {
  const K = ordered.length;
  if (K < 2) return null;
  const idx = new Map<string, number>();
  ordered.forEach((c, i) => idx.set(c, i));

  // Disagreement weight: 0 = identical, 1 = maximum disagreement.
  // Agreement weight (used in formulas) = 1 - disagreement.
  const w = (i: number, j: number): number => {
    const d = scheme === "linear" ? Math.abs(i - j) / (K - 1) : ((i - j) ** 2) / ((K - 1) ** 2);
    return 1 - d;
  };

  // Po_w = sum_{ij} w(i,j) * O[i][j] / N
  // Pe_w = sum_{ij} w(i,j) * (rowMargin[i] / N) * (colMargin[j] / N)
  let PoW = 0;
  let PeW = 0;
  for (const a of ordered) {
    const i = idx.get(a)!;
    for (const b of ordered) {
      const j = idx.get(b)!;
      const o = confusion[a]?.[b] ?? 0;
      PoW += w(i, j) * (o / total);
      const rowP = (aCounts[a] ?? 0) / total;
      const colP = (bCounts[b] ?? 0) / total;
      PeW += w(i, j) * rowP * colP;
    }
  }
  const denom = 1 - PeW;
  return denom === 0 ? 1.0 : (PoW - PeW) / denom;
}

/** Linear-congruential RNG for reproducible bootstrap. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function kappaForPairs(pairs: Array<[string, string]>): number | null {
  if (pairs.length === 0) return null;
  const aCounts: Record<string, number> = {};
  const bCounts: Record<string, number> = {};
  let agree = 0;
  for (const [a, b] of pairs) {
    aCounts[a] = (aCounts[a] ?? 0) + 1;
    bCounts[b] = (bCounts[b] ?? 0) + 1;
    if (a === b) agree++;
  }
  const total = pairs.length;
  const Po = agree / total;
  const cats = new Set([...Object.keys(aCounts), ...Object.keys(bCounts)]);
  let Pe = 0;
  for (const c of cats) {
    Pe += ((aCounts[c] ?? 0) / total) * ((bCounts[c] ?? 0) / total);
  }
  const denom = 1 - Pe;
  return denom === 0 ? 1.0 : (Po - Pe) / denom;
}

function bootstrapKappaCI(
  pairs: Array<[string, string]>,
  n: number,
  seed: number,
): [number, number] | null {
  if (pairs.length < 10 || n < 50) return null;
  const rng = makeRng(seed);
  const samples: number[] = [];
  for (let r = 0; r < n; r++) {
    const resampled: Array<[string, string]> = [];
    for (let i = 0; i < pairs.length; i++) {
      resampled.push(pairs[Math.floor(rng() * pairs.length)]);
    }
    const k = kappaForPairs(resampled);
    if (k !== null && Number.isFinite(k)) samples.push(k);
  }
  if (samples.length < 50) return null;
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * 0.025)];
  const hi = samples[Math.floor(samples.length * 0.975)];
  return [lo, hi];
}
