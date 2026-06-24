// Mirror of app/server/contract-eval.ts safeEval/fieldApplicability/evalDerivation
// for client-side preemptive applicability greying.
// NOTE: Do not import from the server module — server tsconfig may not include
// the client directory. Keep this copy in sync with contract-eval.ts manually.

import { exprStringOf } from "./ui/guideline-logic";

export type Env = Record<string, unknown>;

/** Tiny expression evaluator supporting: == != AND OR `in [list]`, ternary,
 *  string literals, booleans. Returns null on parse failure. Direct port of
 *  ui/src/store.jsx safeEval — keep behavior bit-identical.
 *  IMPORTANT: never expand the allowed-character regex without updating the
 *  cross-evaluator parity test against lib/applicability.py. */
export function safeEval(expr: string, env: Env): unknown {
  // Parity with server contract-eval safeEval: allow arithmetic operators
  // `+ - * /` too. The `/` is load-bearing for string literals that contain a
  // slash (e.g. APOE genotype values "e3/e4"); without it the whole expression
  // is rejected and a derived field wrongly shows "waiting for inputs".
  if (!/^[\w\s\.\=\!\>\<\?\:\(\)\[\]\,\'"@&|+\-*/]+$/i.test(expr)) return null;
  let js = expr
    .replace(/\bAND\b/g, "&&")
    .replace(/\bOR\b/g, "||")
    .replace(/(\w+)\s+in\s+(\[[^\]]*\])/g, "$2.includes($1)");
  const ids = Object.keys(env);
  ids.sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const v = env[id];
    const lit = v === undefined ? "undefined" : JSON.stringify(v);
    js = js.replace(new RegExp("\\b" + id + "\\b", "g"), lit);
  }
  try {
    // eslint-disable-next-line no-new-func
    return Function('"use strict"; return (' + js + ");")();
  } catch {
    return null;
  }
}

export interface TaskField {
  id: string;
  answer_schema?: unknown;
  /** May be a plain DSL string OR `{kind, expr, ...}`. Normalize via
   *  `exprStringOf` before treating as a string. */
  is_applicable_when?: unknown;
  derivation?: unknown;
  is_final_output?: boolean;
  requires_calibration?: boolean;
}

export interface MinimalTask {
  fields: TaskField[];
}

export type Applicability = "applicable" | "not_applicable" | "unknown";

/** Evaluate a field's `is_applicable_when` gate against the current answers.
 *  Direct port of ui/src/store.jsx fieldApplicability. */
export function fieldApplicability(task: MinimalTask, answers: Env, fieldId: string): Applicability {
  const f = task.fields.find((x) => x.id === fieldId);
  const gateExpr = exprStringOf(f?.is_applicable_when);
  if (!gateExpr) return "applicable";
  const referenced = task.fields
    .map((x) => x.id)
    .filter((id) => new RegExp("\\b" + id + "\\b").test(gateExpr));
  const missingInput = referenced.some((id) => answers[id] === undefined);
  if (missingInput) return "unknown";
  const result = safeEval(gateExpr, answers);
  if (result === null || result === undefined) return "unknown";
  return result ? "applicable" : "not_applicable";
}

export function derivedInputs(task: MinimalTask, fieldId: string): string[] {
  const f = task.fields.find((x) => x.id === fieldId);
  const derivExpr = exprStringOf(f?.derivation);
  if (!derivExpr) return [];
  const ids = task.fields.map((x) => x.id);
  return ids.filter((id) => id !== fieldId && new RegExp("\\b" + id + "\\b").test(derivExpr));
}

export function evalDerivation(task: MinimalTask, answers: Env, fieldId: string, visited?: Set<string>): unknown {
  visited = visited ?? new Set();
  const f = task.fields.find((x) => x.id === fieldId);
  const derivExpr = exprStringOf(f?.derivation);
  if (!derivExpr) return null;
  if (visited.has(fieldId)) return null;
  visited.add(fieldId);
  const env: Env = {};
  for (const x of task.fields) {
    if (x.id === fieldId) { env[x.id] = undefined; continue; }
    if (answers[x.id] !== undefined) env[x.id] = answers[x.id];
    else if (exprStringOf(x.derivation)) env[x.id] = evalDerivation(task, answers, x.id, visited);
    else env[x.id] = undefined;
  }
  visited.delete(fieldId);
  // Return null when any referenced input is missing (undefined in env).
  const inputs = derivedInputs(task, fieldId);
  if (inputs.some((id) => env[id] === undefined)) return null;
  return safeEval(derivExpr, env);
}
