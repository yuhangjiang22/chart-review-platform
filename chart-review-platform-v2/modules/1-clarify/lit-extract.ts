// lit-extract clarify adapter — PICO scope.

import type { ClarifyModule, ClarifyOptions, TaskSpec } from "../../shared/types.js";

export interface PicoScope {
  population: string;
  intervention: string;
  comparator?: string;
  outcome: string;
  /** Optional structured-review keywords / inclusion-exclusion criteria.
   *  Phase 1 of lit-search asks for these explicitly. */
  inclusion?: string[];
  exclusion?: string[];
}

export function makeLitExtractClarify(): ClarifyModule {
  return {
    async clarify(prompt: string, opts: ClarifyOptions = {}): Promise<TaskSpec> {
      // MVP: parse PICO from a JSON-shaped prompt. A real implementation
      // would run the lit-search Phase-0/1 interview.
      const scope: PicoScope = parseOrDefault(prompt, {
        population: "adults",
        intervention: "(unspecified)",
        outcome: "(unspecified)",
      });
      const slug =
        slugify(scope.intervention) + "-vs-" + slugify(scope.comparator ?? "control");
      return {
        task_id: slug,
        domain: "lit-extract",
        scope,
        rigor_tier: opts.rigor_tier ?? "lite",
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
