// model-config.ts — single source of truth for which Claude model each
// platform feature uses.
//
// Every code path that picks a model for an SDK call should go through
// `modelFor()` instead of reading env vars directly or hardcoding strings.
// This is the seam where future per-feature routing (e.g. "use a cheaper
// model for codify, a stronger one for build") plugs in cleanly.
//
// Resolution order, highest precedence first:
//   1. Caller-provided override (passed as an argument)
//   2. Per-feature env var (e.g. CHART_REVIEW_JUDGE_MODEL)
//   3. Default env var CHART_REVIEW_MODEL (only when feature === "default")
//   4. Hardcoded fallback in DEFAULTS below
//
// Adding a new feature is a 3-line change: add to ModelFeature union,
// add to DEFAULTS, callers use `modelFor("<new-feature>")`.

/** Feature slots that pick their own model. Add new slots here as the
 *  platform grows. */
export type ModelFeature =
  | "default" // generic agent path (chart review, copilot, etc.)
  | "judge" // chart-review-judge skill (LLM-as-judge over disagreements + low-conf cells)
  | "phi"; // HIPAA-eligible deployment for phi: true patients

/** Hardcoded fallback when no env var is set. Edit here to change the
 *  shipped default for a given feature. Operators usually override these
 *  via env vars; the fallback exists so a fresh checkout works without
 *  configuration. */
const DEFAULTS: Record<ModelFeature, string | undefined> = {
  default: "anthropic/claude-haiku-4.5",
  judge: "anthropic/claude-sonnet-4.6",
  phi: undefined, // No safe shipped default — operators MUST set CHART_REVIEW_PHI_MODEL
};

/** Map a feature to the env var operators use to override its model. */
function envVarFor(feature: ModelFeature): string {
  if (feature === "default") return "CHART_REVIEW_MODEL";
  return `CHART_REVIEW_${feature.toUpperCase()}_MODEL`;
}

/**
 * Resolve which model string to use for a given feature.
 *
 * `caller` — optional explicit override. Wins over everything else if set
 * (used when a route handler wants to pin a specific model regardless of
 * env config, e.g. for testing).
 */
export function modelFor(feature: ModelFeature, caller?: string): string | undefined {
  if (caller) return caller;
  const envVal = process.env[envVarFor(feature)];
  if (envVal) return envVal;
  return DEFAULTS[feature];
}

/** Diagnostic helper: returns the active model resolution for every
 *  feature, including which source (env var / fallback) provided it.
 *  Used by `/api/diagnostics/models` and startup logging. */
export interface ModelResolution {
  feature: ModelFeature;
  model: string | undefined;
  source: "env" | "fallback" | "unset";
  envVar: string;
}

export function describeAllModels(): ModelResolution[] {
  const features: ModelFeature[] = ["default", "judge", "phi"];
  return features.map((f) => {
    const envVar = envVarFor(f);
    const envVal = process.env[envVar];
    if (envVal) return { feature: f, model: envVal, source: "env", envVar };
    const fallback = DEFAULTS[f];
    if (fallback) return { feature: f, model: fallback, source: "fallback", envVar };
    return { feature: f, model: undefined, source: "unset", envVar };
  });
}
