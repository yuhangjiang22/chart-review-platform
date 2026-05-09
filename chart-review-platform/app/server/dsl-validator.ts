import { safeEval } from "./contract-eval.js";

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Validates an `is_applicable_when` DSL expression for parse correctness.
 * Empty string is accepted (means "always applicable" in the platform).
 *
 * Strategy: synthesize a permissive env (every word-token mapped to a string),
 * call safeEval, and treat null result as parse failure.
 */
export function validateDSL(expr: string): ValidationResult {
  if (expr.trim() === "") return { ok: true };

  if (!/^[\w\s\.\=\!\>\<\?\:\(\)\[\]\,\'"@&|]+$/i.test(expr)) {
    return { ok: false, error: "illegal characters in DSL expression" };
  }

  // Build a synthetic env that satisfies any identifier referenced in the expression.
  // Extract identifiers, being careful to exclude string literals.
  const idents = new Set<string>();
  const withoutStrings = expr.replace(/'[^']*'/g, "");
  const matches = withoutStrings.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) ?? [];
  for (const id of matches) {
    idents.add(id);
  }

  const env: Record<string, unknown> = {};
  for (const id of idents) {
    if (id === "AND" || id === "OR" || id === "NOT" || id === "in") continue;
    if (id === "true" || id === "false" || id === "null" || id === "undefined") continue;
    env[id] = "yes"; // arbitrary string — we only care about parse
  }

  const result = safeEval(expr, env);
  if (result === null) {
    return { ok: false, error: "parse error: invalid expression syntax" };
  }
  return { ok: true };
}
