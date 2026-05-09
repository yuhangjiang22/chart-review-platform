export type Env = Record<string, unknown>;

/** Date strings (YYYY-MM-DD) only; anything else returns null. Mirrors
 *  Python derivation._parse_iso_date semantics. */
function _parseISODate(v: unknown): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

/** count_true([a, b, c]) — integer count of truthy operands; null operands
 *  are skipped (not counted as falsy). Mirrors Python _builtin_count_true. */
function count_true(arr: unknown): number {
  if (!Array.isArray(arr)) throw new Error("count_true expects an array");
  let n = 0;
  for (const x of arr) if (x !== null && x !== undefined && Boolean(x)) n += 1;
  return n;
}

/** days_between(d1, d2) — d1 - d2 in integer days for ISO date strings.
 *  Null on null operand or unparseable date. Matches Python builtin. */
function days_between(a: unknown, b: unknown): number | null {
  if (a === null || b === null || a === undefined || b === undefined) return null;
  const da = _parseISODate(a);
  const db = _parseISODate(b);
  if (!da || !db) return null;
  return Math.round((da.getTime() - db.getTime()) / 86_400_000);
}

/** Normalize boolean-equivalent values to canonical JS booleans so that
 *  `imaging_lung_lesion == 'yes'` and `imaging_lung_lesion == true`
 *  evaluate consistently regardless of whether agents wrote a boolean or
 *  a yes/no string. Mirrors the normalizer in disagreements.ts and the
 *  Python `_canonical_bool` so the disagreement extractor and the
 *  derivation evaluator agree on equality.
 *
 *  Returns "true" / "false" (the JS literal text, ready for substitution
 *  into the expression as a JS boolean), or null when the value is not
 *  boolean-equivalent and should be substituted as-is.
 *
 *  Handled cases:
 *    boolean true  / "true" / "yes"  → "true"   (JS boolean, not string)
 *    boolean false / "false" / "no"  → "false"  (JS boolean, not string)
 *  Unaffected: enum strings like 'nsclc', 'no_info', numeric values, dates. */
function _canonicalBoolLit(v: unknown): string | null {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") {
    const lc = v.trim().toLowerCase();
    if (lc === "yes" || lc === "true") return "true";
    if (lc === "no" || lc === "false") return "false";
  }
  return null;
}

/** Tiny expression evaluator supporting: == != > >= < <= AND OR NOT,
 *  `in [list]`, ternary, arithmetic + - * /, string literals, booleans,
 *  and named builtins (count_true, days_between).
 *  Returns null on parse failure or runtime error.
 *  IMPORTANT: never expand the allowed-character regex without updating the
 *  cross-evaluator parity test (lib/tests/test_contract_eval.py). */
export function safeEval(expr: string, env: Env): unknown {
  if (!/^[\w\s\.\=\!\>\<\?\:\(\)\[\]\,\'"@&|+\-*/]+$/i.test(expr)) return null;
  let js = expr
    .replace(/\bAND\b/g, "&&")
    .replace(/\bOR\b/g, "||")
    .replace(/(\w+)\s+in\s+(\[[^\]]*\])/g, "$2.includes($1)");
  // Normalize boolean-equivalent string literals ONLY where they're
  // operands of a comparison or members of an `in [...]` list — so
  // `imaging_lung_lesion == 'yes'` matches a boolean true value, while
  // `... ? 'yes' : 'no'` (ternary result strings) stays untouched.
  // Anything not in a comparison context passes through unchanged.
  // Substitution emits JS booleans (`true` / `false`), not strings,
  // so downstream operators (count_true, &&, ||) see canonical truthy/
  // falsy values.
  const normalizeBoolLitRe = /(['"])(yes|no|true|false)\1/gi;
  const litToBool = (lit: string): string =>
    lit.toLowerCase() === "yes" || lit.toLowerCase() === "true" ? "true" : "false";
  // RHS of == / !=
  js = js.replace(/(==|!=)\s*(['"])(yes|no|true|false)\2/gi, (_full, op, _q, lit) =>
    `${op} ${litToBool(lit)}`,
  );
  // LHS of == / !=
  js = js.replace(/(['"])(yes|no|true|false)\1\s*(==|!=)/gi, (_full, _q, lit, op) =>
    `${litToBool(lit)} ${op}`,
  );
  // List elements: ['yes', 'no'] → [true, false]
  js = js.replace(/\[([^\]]*)\]/g, (_full, inner) =>
    `[${inner.replace(normalizeBoolLitRe, (_l: string, _q: string, lit: string) => litToBool(lit))}]`,
  );
  const ids = Object.keys(env);
  ids.sort((a, b) => b.length - a.length);
  for (const id of ids) {
    if (id === "count_true" || id === "days_between") continue; // never shadow builtins
    const v = env[id];
    // Substitute null/undefined as JS `undefined` so that arithmetic
    // produces NaN (which we coerce to null below) instead of JS's
    // coerce-null-to-zero behavior. `undefined == null` is true, so
    // equality semantics with literal `null` are preserved.
    // For boolean-equivalent values (true/false/'yes'/'no'), substitute
    // the canonical string form so equality compares stably across the
    // formats different agents may emit.
    const canonical = _canonicalBoolLit(v);
    const lit =
      v === undefined || v === null
        ? "undefined"
        : (canonical ?? JSON.stringify(v));
    js = js.replace(new RegExp("\\b" + id + "\\b", "g"), lit);
  }
  try {
    // Inject builtins into the eval closure as named parameters; arithmetic
    // (+ - * /) is handled natively by the JS engine.
    // eslint-disable-next-line no-new-func
    const result = Function(
      "count_true",
      "days_between",
      '"use strict"; return (' + js + ");",
    )(count_true, days_between);
    // NaN (null operand), Infinity (5/0), -Infinity (-5/0) → null.
    if (typeof result === "number" && !Number.isFinite(result)) return null;
    return result;
  } catch {
    return null;
  }
}

export interface TaskField {
  id: string;
  answer_schema?: unknown;
  is_applicable_when?: string;
  derivation?: string;
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
  if (!f?.is_applicable_when) return "applicable";
  const referenced = task.fields
    .map((x) => x.id)
    .filter((id) => new RegExp("\\b" + id + "\\b").test(f.is_applicable_when!));
  const missingInput = referenced.some((id) => answers[id] === undefined);
  if (missingInput) return "unknown";
  const result = safeEval(f.is_applicable_when, answers);
  if (result === null || result === undefined) return "unknown";
  return result ? "applicable" : "not_applicable";
}

/**
 * Return the field IDs referenced in a field's `is_applicable_when` gate
 * expression. Used by the commit gate to surface DEPENDENCIES (not the gated
 * field itself) when a gate cannot be evaluated due to missing inputs.
 */
export function gateReferencedIds(task: MinimalTask, fieldId: string): string[] {
  const f = task.fields.find((x) => x.id === fieldId);
  if (!f?.is_applicable_when) return [];
  return task.fields
    .map((x) => x.id)
    .filter((id) => new RegExp("\\b" + id + "\\b").test(f.is_applicable_when!));
}

export function derivedInputs(task: MinimalTask, fieldId: string): string[] {
  const f = task.fields.find((x) => x.id === fieldId);
  if (!f?.derivation) return [];
  const ids = task.fields.map((x) => x.id);
  return ids.filter((id) => id !== fieldId && new RegExp("\\b" + id + "\\b").test(f.derivation!));
}

export function evalDerivation(task: MinimalTask, answers: Env, fieldId: string, visited?: Set<string>): unknown {
  visited = visited ?? new Set();
  const f = task.fields.find((x) => x.id === fieldId);
  if (!f?.derivation) return null;
  if (visited.has(fieldId)) return null;
  visited.add(fieldId);
  const env: Env = {};
  for (const x of task.fields) {
    if (x.id === fieldId) { env[x.id] = undefined; continue; }
    if (answers[x.id] !== undefined) env[x.id] = answers[x.id];
    else if (x.derivation) env[x.id] = evalDerivation(task, answers, x.id, visited);
    else env[x.id] = undefined;
  }
  visited.delete(fieldId);
  // Return null when any referenced input is missing (undefined in env).
  const inputs = derivedInputs(task, fieldId);
  if (inputs.some((id) => env[id] === undefined)) return null;
  return safeEval(f.derivation, env);
}

export interface EvidenceLike {
  source: "note" | "structured" | "derived_from";
  note_id?: string;
  start?: number;
  end?: number;
  span_offsets?: [number, number];
  table?: string;
  row_id?: string;
  from?: string[];
}

/** Direct port of ui/src/store.jsx evidenceSignature (line 261-267).
 *  NOTE: no fallback defaults for start/end — matches source exactly. */
export function evidenceSignature(e: EvidenceLike | undefined | null): string {
  if (!e) return "";
  if (e.source === "note") return `note:${e.note_id}:${e.start}:${e.end}`;
  if (e.source === "structured") return `struct:${e.table}:${e.row_id}`;
  if (e.source === "derived_from") return `der:${(e.from ?? []).join(",")}`;
  return JSON.stringify(e);
}

export interface DivergeInput {
  answer?: unknown;
  evidence?: EvidenceLike[];
}

export function divergedFromAgent(current: DivergeInput, snapshot: DivergeInput | null): boolean {
  if (!snapshot) return false;
  if (current.answer !== snapshot.answer) return true;
  if ((current.evidence?.length ?? 0) !== (snapshot.evidence?.length ?? 0)) return true;
  const sigs = (xs?: EvidenceLike[]) => (xs ?? []).map(evidenceSignature).sort().join("|");
  return sigs(current.evidence) !== sigs(snapshot.evidence);
}
