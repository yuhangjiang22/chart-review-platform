// chart-review clarify adapter — phenotype scope.

import type { ClarifyModule, ClarifyOptions, TaskSpec } from "../../shared/types.js";

export interface PhenotypeScope {
  population: string;       // e.g. "adult patients seen in oncology clinic"
  condition: string;        // e.g. "non-small-cell lung cancer"
  lookback_months: number;  // index date + lookback window
  index_date_rule: string;  // e.g. "first oncology encounter in window"
}

export function makeChartReviewClarify(): ClarifyModule {
  return {
    async clarify(prompt: string, opts: ClarifyOptions = {}): Promise<TaskSpec> {
      // MVP: parse a JSON-shaped prompt for the phenotype scope. A real
      // implementation would run a structured interview (or call the
      // existing chart-review-author skill) to extract these fields.
      const scope: PhenotypeScope = parseOrDefault(prompt, {
        population: "adult patients",
        condition: "lung cancer",
        lookback_months: 24,
        index_date_rule: "first encounter in lookback window",
      });
      return {
        task_id: slugify(scope.condition) + "-phenotype",
        domain: "chart-review",
        scope,
        rigor_tier: opts.rigor_tier ?? "full",
        created_at: new Date().toISOString(),
        created_by: opts.user_id ?? "anonymous",
      };
    },
  };
}

function parseOrDefault<T>(s: string, fallback: T): T {
  try { return { ...fallback, ...JSON.parse(s) } as T; } catch { return fallback; }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
