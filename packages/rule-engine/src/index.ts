/**
 * Deterministic rule engine for adherence tasks.
 *
 * A rule is a small boolean expression over `QuestionAnswer.answer`
 * values, identified by `question_id`. The engine evaluates the
 * expression in pure JS (no eval, no Function() — a tiny AST walker)
 * and emits a `RuleVerdict`.
 *
 * For rules marked `nuanced: true`, the caller passes an `llmJudge`
 * callback that receives the rule + supporting answers and returns
 * the verdict + rationale; this path is what handles "is this
 * documentation a contraindication, or just a missing note" calls
 * that the boolean DSL cannot decide.
 *
 * Supported expression grammar (subset):
 *
 *     expr  := atom
 *            | "not" expr
 *            | expr ("and"|"or") expr
 *            | "(" expr ")"
 *     atom  := QID ("==" | "!=" | ">=" | "<=" | ">" | "<") LITERAL
 *            | QID "in" "[" LITERAL ("," LITERAL)* "]"
 *            | QID                              # truthy check
 *            | QID "is" ("missing"|"present")
 *     QID    := identifier (matches a question_id in references/questions/*.yaml)
 *     LITERAL := number | "string" | true | false | null
 *
 * Rationale: keeps the DSL boring + auditable. Authors write rules in
 * references/rules/*.yaml as plain English with `verdict_if` strings;
 * the engine just answers "did the expression hold?".
 */

import type {
  QuestionAnswer, RuleVerdict, AttributionCategory, RuleEvent, RuleRollup,
} from "@chart-review/platform-types";

// ── Rule schema (matches references/rules/*.yaml) ────────────────────────────

export interface RuleDefinition {
  /** Stable id, e.g. "R-T1-001". Used as RuleVerdict.rule_id. */
  rule_id: string;
  /** Human-readable description shown in UI + Methods text. */
  description: string;
  /** Boolean expression over question_ids. See grammar above. */
  verdict_if: string;
  /** When `verdict_if` evaluates true → CONCORDANT; false → NON_CONCORDANT.
   *  Invert when true means "guideline was violated". */
  invert?: boolean;
  /** Optional exclusion expression — when this holds, verdict is
   *  EXCLUDED regardless of `verdict_if`. Use for eligibility gates. */
  excluded_if?: string;
  /** Attribution mapping for NON_CONCORDANT verdicts. Either a
   *  constant category, or an attribution_when array that maps
   *  expressions → category for finer-grained reasoning. */
  attribution?: AttributionCategory;
  attribution_when?: Array<{
    when: string;
    category: AttributionCategory;
  }>;
  /** When true, after the deterministic verdict is computed, the LLM
   *  judge gets a chance to refine attribution + rationale. The
   *  deterministic verdict still stands unless the judge explicitly
   *  overrides via judge_can_override=true. */
  nuanced?: boolean;
  judge_can_override?: boolean;
  /** Optional list of question_ids that feed this rule — used for
   *  drill-down UI and to scope the LLM-judge prompt. Computed
   *  automatically from `verdict_if` parsing if omitted. */
  supporting_questions?: string[];
  /** Name(s) of per-patient anchor lists this rule expands over
   *  (spec 2026-08-24). Omitted = one window-spanning event —
   *  current single-verdict behavior. */
  event_anchor?: string | string[];
  /** Per-event applicability expression over the event's merged answer
   *  map (patient answers overlaid with event answers, plus the
   *  synthetic `_anchor_type` answer). False → event not evaluable. */
  event_evaluable_if?: string;
}

// ── AST types (internal) ─────────────────────────────────────────────────────

type AstAtom =
  | { kind: "compare"; qid: string; op: "==" | "!=" | ">=" | "<=" | ">" | "<"; rhs: AnswerValue }
  | { kind: "in"; qid: string; values: AnswerValue[] }
  | { kind: "truthy"; qid: string }
  | { kind: "missing"; qid: string }
  | { kind: "present"; qid: string };

type Ast =
  | AstAtom
  | { kind: "not"; inner: Ast }
  | { kind: "and"; left: Ast; right: Ast }
  | { kind: "or"; left: Ast; right: Ast };

type AnswerValue = string | number | boolean | null;

// ── Tokenizer ────────────────────────────────────────────────────────────────

type Token =
  | { type: "id"; v: string }
  | { type: "num"; v: number }
  | { type: "str"; v: string }
  | { type: "true" } | { type: "false" } | { type: "null" }
  | { type: "and" } | { type: "or" } | { type: "not" } | { type: "in" } | { type: "is" }
  | { type: "missing" } | { type: "present" }
  | { type: "lparen" } | { type: "rparen" } | { type: "lbracket" } | { type: "rbracket" } | { type: "comma" }
  | { type: "op"; v: "==" | "!=" | ">=" | "<=" | ">" | "<" }
  | { type: "eof" };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(") { out.push({ type: "lparen" }); i++; continue; }
    if (c === ")") { out.push({ type: "rparen" }); i++; continue; }
    if (c === "[") { out.push({ type: "lbracket" }); i++; continue; }
    if (c === "]") { out.push({ type: "rbracket" }); i++; continue; }
    if (c === ",") { out.push({ type: "comma" }); i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c; i++;
      let buf = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) { buf += src[i + 1]; i += 2; continue; }
        buf += src[i]; i++;
      }
      if (src[i] !== quote) throw new Error(`unterminated string at ${i}`);
      i++;
      out.push({ type: "str", v: buf });
      continue;
    }
    if (c === "=" && src[i + 1] === "=") { out.push({ type: "op", v: "==" }); i += 2; continue; }
    if (c === "!" && src[i + 1] === "=") { out.push({ type: "op", v: "!=" }); i += 2; continue; }
    if (c === ">" && src[i + 1] === "=") { out.push({ type: "op", v: ">=" }); i += 2; continue; }
    if (c === "<" && src[i + 1] === "=") { out.push({ type: "op", v: "<=" }); i += 2; continue; }
    if (c === ">") { out.push({ type: "op", v: ">" }); i++; continue; }
    if (c === "<") { out.push({ type: "op", v: "<" }); i++; continue; }
    if (/[0-9-]/.test(c)) {
      const m = src.slice(i).match(/^-?\d+(\.\d+)?/);
      if (!m) throw new Error(`bad number at ${i}`);
      out.push({ type: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.-]*/);
      const v = m![0];
      i += v.length;
      const lower = v.toLowerCase();
      if (lower === "and") out.push({ type: "and" });
      else if (lower === "or") out.push({ type: "or" });
      else if (lower === "not") out.push({ type: "not" });
      else if (lower === "in") out.push({ type: "in" });
      else if (lower === "is") out.push({ type: "is" });
      else if (lower === "missing") out.push({ type: "missing" });
      else if (lower === "present") out.push({ type: "present" });
      else if (lower === "true") out.push({ type: "true" });
      else if (lower === "false") out.push({ type: "false" });
      else if (lower === "null") out.push({ type: "null" });
      else out.push({ type: "id", v });
      continue;
    }
    throw new Error(`unexpected '${c}' at position ${i}`);
  }
  out.push({ type: "eof" });
  return out;
}

// ── Recursive-descent parser ────────────────────────────────────────────────

class Parser {
  pos = 0;
  constructor(private toks: Token[]) {}
  peek(): Token { return this.toks[this.pos]!; }
  eat(): Token { return this.toks[this.pos++]!; }
  expect<T extends Token["type"]>(t: T): Token {
    const tok = this.eat();
    if (tok.type !== t) throw new Error(`expected ${t}, got ${tok.type}`);
    return tok;
  }
  parseExpr(): Ast { return this.parseOr(); }
  parseOr(): Ast {
    let left = this.parseAnd();
    while (this.peek().type === "or") {
      this.eat();
      left = { kind: "or", left, right: this.parseAnd() };
    }
    return left;
  }
  parseAnd(): Ast {
    let left = this.parseNot();
    while (this.peek().type === "and") {
      this.eat();
      left = { kind: "and", left, right: this.parseNot() };
    }
    return left;
  }
  parseNot(): Ast {
    if (this.peek().type === "not") {
      this.eat();
      return { kind: "not", inner: this.parseNot() };
    }
    return this.parsePrimary();
  }
  parsePrimary(): Ast {
    const tok = this.peek();
    if (tok.type === "lparen") {
      this.eat();
      const inner = this.parseExpr();
      this.expect("rparen");
      return inner;
    }
    if (tok.type === "id") {
      this.eat();
      const qid = tok.v;
      const next = this.peek();
      if (next.type === "op") {
        this.eat();
        const rhs = this.parseLiteral();
        return { kind: "compare", qid, op: next.v, rhs };
      }
      if (next.type === "in") {
        this.eat();
        this.expect("lbracket");
        const values: AnswerValue[] = [this.parseLiteral()];
        while (this.peek().type === "comma") {
          this.eat();
          values.push(this.parseLiteral());
        }
        this.expect("rbracket");
        return { kind: "in", qid, values };
      }
      if (next.type === "is") {
        this.eat();
        const what = this.eat();
        if (what.type === "missing") return { kind: "missing", qid };
        if (what.type === "present") return { kind: "present", qid };
        throw new Error(`'is' must be followed by missing|present, got ${what.type}`);
      }
      return { kind: "truthy", qid };
    }
    throw new Error(`unexpected token ${tok.type} at start of primary`);
  }
  parseLiteral(): AnswerValue {
    const tok = this.eat();
    if (tok.type === "num") return tok.v;
    if (tok.type === "str") return tok.v;
    if (tok.type === "true") return true;
    if (tok.type === "false") return false;
    if (tok.type === "null") return null;
    throw new Error(`expected literal, got ${tok.type}`);
  }
}

export function parseExpression(src: string): Ast {
  const toks = tokenize(src);
  const p = new Parser(toks);
  const ast = p.parseExpr();
  if (p.peek().type !== "eof") throw new Error("trailing tokens");
  return ast;
}

// ── Evaluator ────────────────────────────────────────────────────────────────

function collectQids(ast: Ast, into: Set<string>): void {
  switch (ast.kind) {
    case "compare": case "in": case "truthy":
    case "missing": case "present":
      into.add(ast.qid); break;
    case "not":
      collectQids(ast.inner, into); break;
    case "and": case "or":
      collectQids(ast.left, into);
      collectQids(ast.right, into); break;
  }
}

function compareValues(left: AnswerValue, op: string, right: AnswerValue): boolean {
  if (left === null || right === null) {
    if (op === "==") return left === right;
    if (op === "!=") return left !== right;
    return false;
  }
  switch (op) {
    case "==": return left === right;
    case "!=": return left !== right;
    case ">":  return (left as number) > (right as number);
    case "<":  return (left as number) < (right as number);
    case ">=": return (left as number) >= (right as number);
    case "<=": return (left as number) <= (right as number);
  }
  return false;
}

function evalAst(ast: Ast, answers: Map<string, QuestionAnswer>): boolean {
  switch (ast.kind) {
    case "and": return evalAst(ast.left, answers) && evalAst(ast.right, answers);
    case "or":  return evalAst(ast.left, answers) || evalAst(ast.right, answers);
    case "not": return !evalAst(ast.inner, answers);
    case "missing": return !answers.has(ast.qid) || answers.get(ast.qid)!.answer === null;
    case "present": return answers.has(ast.qid) && answers.get(ast.qid)!.answer !== null;
    case "truthy": {
      const a = answers.get(ast.qid);
      if (!a) return false;
      return Boolean(a.answer);
    }
    case "compare": {
      const a = answers.get(ast.qid);
      if (!a) return false;
      return compareValues(a.answer, ast.op, ast.rhs);
    }
    case "in": {
      const a = answers.get(ast.qid);
      if (!a) return false;
      return ast.values.some((v) => v === a.answer);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface LlmJudgeRequest {
  rule: RuleDefinition;
  deterministic_verdict: RuleVerdict;
  supporting_answers: QuestionAnswer[];
}
export interface LlmJudgeResponse {
  verdict?: "CONCORDANT" | "NON_CONCORDANT" | "EXCLUDED";
  attribution?: AttributionCategory;
  rationale: string;
}

/** Stable position-independent compile of one rule. Caller can cache
 *  the compiled form across patients (the AST + qid set never depend
 *  on answer values). */
export interface CompiledRule {
  rule: RuleDefinition;
  verdict_ast: Ast;
  excluded_ast: Ast | null;
  attribution_when_compiled: Array<{ ast: Ast; category: AttributionCategory }>;
  qids: string[];
}

export function compileRule(rule: RuleDefinition): CompiledRule {
  const verdictAst = parseExpression(rule.verdict_if);
  const excludedAst = rule.excluded_if ? parseExpression(rule.excluded_if) : null;
  const qids = new Set<string>();
  collectQids(verdictAst, qids);
  if (excludedAst) collectQids(excludedAst, qids);
  const attributionWhenCompiled = (rule.attribution_when ?? []).map((aw) => {
    const ast = parseExpression(aw.when);
    collectQids(ast, qids);
    return { ast, category: aw.category };
  });
  return {
    rule,
    verdict_ast: verdictAst,
    excluded_ast: excludedAst,
    attribution_when_compiled: attributionWhenCompiled,
    qids: [...qids],
  };
}

/** Evaluate one compiled rule against the patient's answers.
 *  Pure / deterministic. */
export function evaluateRule(
  compiled: CompiledRule,
  answers: QuestionAnswer[],
): RuleVerdict {
  const map = new Map<string, QuestionAnswer>();
  for (const a of answers) map.set(a.question_id, a);

  // 1. Eligibility gate.
  if (compiled.excluded_ast && evalAst(compiled.excluded_ast, map)) {
    return {
      rule_id: compiled.rule.rule_id,
      verdict: "EXCLUDED",
      supporting_questions: compiled.qids,
      source: "rule_engine",
      ts: new Date().toISOString(),
    };
  }

  // 2. Deterministic boolean.
  const raw = evalAst(compiled.verdict_ast, map);
  const concordant = compiled.rule.invert ? !raw : raw;
  if (concordant) {
    return {
      rule_id: compiled.rule.rule_id,
      verdict: "CONCORDANT",
      supporting_questions: compiled.qids,
      source: "rule_engine",
      ts: new Date().toISOString(),
    };
  }

  // 3. NON_CONCORDANT — pick attribution.
  let attribution: AttributionCategory | undefined = compiled.rule.attribution;
  for (const aw of compiled.attribution_when_compiled) {
    if (evalAst(aw.ast, map)) { attribution = aw.category; break; }
  }
  return {
    rule_id: compiled.rule.rule_id,
    verdict: "NON_CONCORDANT",
    attribution: attribution ?? "OTHER",
    supporting_questions: compiled.qids,
    source: "rule_engine",
    ts: new Date().toISOString(),
  };
}

export interface RuleEngineOpts {
  /** Optional callback for nuanced rules. When omitted, nuanced rules
   *  fall back to the deterministic verdict with no rationale. */
  llmJudge?: (req: LlmJudgeRequest) => Promise<LlmJudgeResponse>;
}

/** Evaluate every rule. Nuanced rules get a follow-up judge call when
 *  `opts.llmJudge` is provided; otherwise their deterministic verdict
 *  stands. */
export async function evaluateAllRules(
  rules: RuleDefinition[],
  answers: QuestionAnswer[],
  opts: RuleEngineOpts = {},
): Promise<RuleVerdict[]> {
  const out: RuleVerdict[] = [];
  for (const rule of rules) {
    let compiled: CompiledRule;
    try {
      compiled = compileRule(rule);
    } catch (e) {
      out.push({
        rule_id: rule.rule_id,
        verdict: "NON_CONCORDANT",
        attribution: "OTHER",
        rationale: `rule compile error: ${(e as Error).message}`,
        source: "rule_engine",
        ts: new Date().toISOString(),
      });
      continue;
    }
    const verdict = evaluateRule(compiled, answers);
    if (rule.nuanced && opts.llmJudge && verdict.verdict !== "EXCLUDED") {
      const supporting = answers.filter((a) => compiled.qids.includes(a.question_id));
      try {
        const judged = await opts.llmJudge({
          rule, deterministic_verdict: verdict, supporting_answers: supporting,
        });
        const finalVerdict = rule.judge_can_override && judged.verdict
          ? judged.verdict
          : verdict.verdict;
        // Attribution only meaningful for NON_CONCORDANT verdicts —
        // suppress the judge-supplied attribution on CONCORDANT /
        // EXCLUDED to keep the UI clean.
        const finalAttribution = finalVerdict === "NON_CONCORDANT"
          ? (judged.attribution ?? verdict.attribution)
          : undefined;
        out.push({
          ...verdict,
          verdict: finalVerdict,
          attribution: finalAttribution,
          rationale: judged.rationale,
          source: "llm_judge",
        });
        continue;
      } catch (e) {
        // Judge failed — keep deterministic verdict, annotate rationale.
        out.push({
          ...verdict,
          rationale: `judge failed: ${(e as Error).message}`,
        });
        continue;
      }
    }
    out.push(verdict);
  }
  return out;
}

// ── Event-level evaluation (spec 2026-08-24) ─────────────────────────────────

/** Merged answer list for one event: patient-level answers, overlaid by the
 *  event's own answers (same question_id shadows), plus `_anchor_type`.
 *  `_anchor_type` is a reserved synthetic question_id — a real question
 *  authored with that id would be shadowed by this synthetic value. */
function mergedAnswers(patient: QuestionAnswer[], event: RuleEvent): QuestionAnswer[] {
  const map = new Map<string, QuestionAnswer>();
  for (const a of patient) map.set(a.question_id, a);
  for (const a of event.answers ?? []) map.set(a.question_id, a);
  map.set("_anchor_type", { question_id: "_anchor_type", tier: -1, answer: event.anchor.type });
  return [...map.values()];
}

export interface RuleEventsResult {
  rule_events: RuleEvent[];
  rule_rollups: RuleRollup[];
  /** Period verdicts mirrored from the rollups — same shape existing
   *  consumers (AdherenceReview, compare.py, IAA) already read. */
  rule_verdicts: RuleVerdict[];
}

/** Reason stamped on an event the engine itself marked not evaluable (via
 *  `event_evaluable_if`). Re-evaluation is idempotent because of this
 *  sentinel: an event carrying exactly this reason is re-derived from
 *  scratch on the next pass (not short-circuited), so newly-supplied
 *  answers can flip it back to evaluable. Any other `evaluable_reason`
 *  string is agent-supplied and authoritative — it always short-circuits. */
export const ENGINE_NOT_EVALUABLE_REASON = "event_evaluable_if not met";

/** Anchor type stamped on the single synthetic event a rule gets when no
 *  input events reference its rule_id (see `windowEventStub`). */
export const WINDOW_ANCHOR_TYPE = "window";

/** The default single-event stub for a rule with no matching input events —
 *  current single-verdict behavior, evaluated over patient-level answers
 *  only. */
export function windowEventStub(ruleId: string): RuleEvent {
  return {
    event_id: `${ruleId}@window`,
    rule_id: ruleId,
    anchor: { type: WINDOW_ANCHOR_TYPE, origin: "omop" as const },
  };
}

/** Evaluate one rule over its events; also compute the rollup.
 *  Duplicate `event_id`s across `events` are NOT deduplicated — the
 *  caller (deterministic upstream event enumeration) is assumed to never
 *  produce them. */
export function evaluateRuleEvents(
  rule: RuleDefinition,
  patientAnswers: QuestionAnswer[],
  events: RuleEvent[],
): { events: RuleEvent[]; rollup: RuleRollup; qids: string[] } {
  const compiled = compileRule(rule);
  const evaluableAst = rule.event_evaluable_if
    ? parseExpression(rule.event_evaluable_if)
    : null;

  const outEvents: RuleEvent[] = events.map((e) => {
    if (e.evaluable === false && e.evaluable_reason !== ENGINE_NOT_EVALUABLE_REASON) {
      return { ...e, verdict: undefined, attribution: undefined };
    }
    const merged = mergedAnswers(patientAnswers, e);
    if (evaluableAst) {
      const map = new Map(merged.map((a) => [a.question_id, a]));
      if (!evalAst(evaluableAst, map)) {
        return {
          ...e,
          evaluable: false,
          evaluable_reason: e.evaluable_reason ?? ENGINE_NOT_EVALUABLE_REASON,
          verdict: undefined,
          attribution: undefined,
        };
      }
    }
    const v = evaluateRule(compiled, merged);
    return { ...e, evaluable: true, evaluable_reason: undefined, verdict: v.verdict, attribution: v.attribution };
  });

  let nConc = 0, nNon = 0, nExc = 0;
  let periodAttribution: RuleRollup["period_attribution"];
  for (const e of outEvents) {
    if (e.evaluable === false) continue;
    if (e.verdict === "CONCORDANT") nConc++;
    else if (e.verdict === "NON_CONCORDANT") {
      nNon++;
      periodAttribution ??= e.attribution;
    } else nExc++;
  }
  const nEval = nConc + nNon;
  const rollup: RuleRollup = {
    rule_id: rule.rule_id,
    n_events: outEvents.length,
    n_evaluable: nEval,
    n_concordant: nConc,
    n_non_concordant: nNon,
    n_excluded: nExc,
    rate: nEval > 0 ? nConc / nEval : null,
    period_verdict: nNon > 0 ? "NON_CONCORDANT" : nConc > 0 ? "CONCORDANT" : "EXCLUDED",
    period_attribution: nNon > 0 ? periodAttribution : undefined,
  };
  return { events: outEvents, rollup, qids: compiled.qids };
}

/** Evaluate every rule over the patient's events. Anchor-FREE rules (no
 *  `event_anchor`) with no events in the list get one default window event
 *  (current single-verdict behavior). Anchored rules with zero events —
 *  an empty or missing anchor list, and no agent-supplemented events — roll
 *  up EXCLUDED instead: the denominator for an anchored rule is
 *  anchor-defined, so zero anchors means zero obligation, not an implicit
 *  patient-level judgment (see `evaluateRuleEvents`'s all-zero rollup on an
 *  empty `events` array). Input events whose rule_id matches none of
 *  `rules` pass through into `rule_events` unevaluated — no rollup or
 *  verdict is produced for them.
 *
 *  A rule that fails to compile (malformed `verdict_if` / `excluded_if` /
 *  `event_evaluable_if`) does not abort the batch: its input events pass
 *  through unevaluated and the rule gets a NON_CONCORDANT rollup + verdict
 *  carrying the compile-error rationale, mirroring `evaluateAllRules`'
 *  per-rule compile-error containment (see there).
 *
 *  Nuanced-rule judge refinement (`evaluateAllRules`' `opts.llmJudge`) is
 *  intentionally NOT supported on the event path — the adherence batch
 *  runner never passes a judge today, and the spec (2026-08-24) scopes
 *  per-event judging out. Revisit this signature (sync → async + opts) if
 *  that changes. */
export function evaluateAllRuleEvents(
  rules: RuleDefinition[],
  patientAnswers: QuestionAnswer[],
  events: RuleEvent[],
): RuleEventsResult {
  const byRule = new Map<string, RuleEvent[]>();
  for (const e of events) {
    const arr = byRule.get(e.rule_id) ?? [];
    arr.push(e);
    byRule.set(e.rule_id, arr);
  }
  const knownRuleIds = new Set(rules.map((r) => r.rule_id));
  const allEvents: RuleEvent[] = [];
  const rollups: RuleRollup[] = [];
  const verdicts: RuleVerdict[] = [];
  for (const rule of rules) {
    // Window-stub fallback applies ONLY to anchor-free rules. An anchored
    // rule with zero input events (empty/missing anchor list) must NOT
    // fall back to a patient-level window judgment — that resurrects the
    // v0.4 false-gap bug (e.g. R-T1-ControllerForPersistent firing
    // NON_CONCORDANT on a well-controlled SABA-only patient with zero
    // obligation anchors). It gets zero events instead, which
    // `evaluateRuleEvents` already rolls up to EXCLUDED / rate null.
    const ruleEvents = byRule.get(rule.rule_id)
      ?? (rule.event_anchor ? [] : [windowEventStub(rule.rule_id)]);
    try {
      const { events: evs, rollup, qids } = evaluateRuleEvents(rule, patientAnswers, ruleEvents);
      allEvents.push(...evs);
      rollups.push(rollup);
      verdicts.push({
        rule_id: rule.rule_id,
        verdict: rollup.period_verdict,
        ...(rollup.period_verdict === "NON_CONCORDANT"
          ? { attribution: rollup.period_attribution ?? "OTHER" }
          : {}),
        supporting_questions: qids,
        source: "rule_engine",
        ts: new Date().toISOString(),
      });
    } catch (e) {
      // Compile error (malformed expression) — contain to this rule, mirror
      // evaluateAllRules' per-rule try/catch. Input events pass through
      // unevaluated; rollup is all-zero except n_events. Scrub any stale
      // verdict/attribution from a prior pass so a round-tripped event
      // doesn't retain a verdict while the rollup reports zero counts.
      allEvents.push(...ruleEvents.map((e) => ({ ...e, verdict: undefined, attribution: undefined })));
      rollups.push({
        rule_id: rule.rule_id,
        n_events: ruleEvents.length,
        n_evaluable: 0,
        n_concordant: 0,
        n_non_concordant: 0,
        n_excluded: 0,
        rate: null,
        period_verdict: "NON_CONCORDANT",
      });
      verdicts.push({
        rule_id: rule.rule_id,
        verdict: "NON_CONCORDANT",
        attribution: "OTHER",
        rationale: `rule compile error: ${(e as Error).message}`,
        source: "rule_engine",
        ts: new Date().toISOString(),
      });
    }
  }
  // Orphan events: rule_id present in the input but not in `rules` — pass
  // through unevaluated, with no rollup or verdict.
  for (const [ruleId, evs] of byRule) {
    if (!knownRuleIds.has(ruleId)) allEvents.push(...evs);
  }
  return { rule_events: allEvents, rule_rollups: rollups, rule_verdicts: verdicts };
}
