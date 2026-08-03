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
  QuestionAnswer, RuleVerdict, AttributionCategory,
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
