export interface IterSnapshot {
  iter_id: string;
  per_criterion: Array<{
    field_id: string;
    accuracy: number | null;
    n_evaluable: number;
    n_correct: number;
  }>;
  override_count: number;
}

export interface EligibilityResult {
  eligible: boolean;
  consecutive_passing: number;
  required_consecutive: number;
  failing_criteria: Array<{ field_id: string; accuracy: number | null; iter_id: string }>;
  override_growth: number; // newest - previous; positive means it grew
}

const THRESHOLD = 0.9;
const REQUIRED_CONSECUTIVE = 2;

function passes(iter: IterSnapshot): boolean {
  return iter.per_criterion.every((c) => c.accuracy != null && c.accuracy >= THRESHOLD);
}

/**
 * iters: array ordered oldest → newest. Computes whether the most recent
 * REQUIRED_CONSECUTIVE iters all pass and override_count is non-increasing
 * (i.e., override_growth <= 0).
 */
export function computeEligibility(iters: IterSnapshot[]): EligibilityResult {
  // Count consecutive passing iters from the tail.
  let consecutive = 0;
  for (let i = iters.length - 1; i >= 0; i--) {
    if (!passes(iters[i])) break;
    consecutive += 1;
    if (consecutive === REQUIRED_CONSECUTIVE) break;
  }

  // Collect failing criteria from the last REQUIRED_CONSECUTIVE iters.
  const last = iters.slice(-REQUIRED_CONSECUTIVE);
  const failing: EligibilityResult["failing_criteria"] = [];
  for (const it of last) {
    for (const c of it.per_criterion) {
      if (c.accuracy == null || c.accuracy < THRESHOLD) {
        failing.push({ field_id: c.field_id, accuracy: c.accuracy, iter_id: it.iter_id });
      }
    }
  }

  // Override growth: newest minus previous. Positive means it grew (blocking).
  const overrideGrowth =
    last.length === 2 ? last[1].override_count - last[0].override_count : 0;

  const eligible = consecutive >= REQUIRED_CONSECUTIVE && overrideGrowth <= 0;

  return {
    eligible,
    consecutive_passing: consecutive,
    required_consecutive: REQUIRED_CONSECUTIVE,
    failing_criteria: failing,
    override_growth: overrideGrowth,
  };
}
