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
  /** Per-event applicability expression over the event's answer map (see
   *  `event_scoped_questions` for what that map contains, plus the synthetic
   *  `_anchor_type` answer). False → event not evaluable. */
  event_evaluable_if?: string;
  /** How long after an event its requirement is judged, in days.
   *
   *  Part of the clinical definition, not presentation: "follow-up scheduled
   *  within 3 MONTHS of this event" is a 90-day judgment window, and a
   *  reviewer looking at one event needs to know what span they are judging.
   *  Omitted → the requirement is judged AS OF the event date (the regimen in
   *  force that day), a point rather than a span.
   *
   *  An event whose anchor carries `meta.deadline` overrides this: the
   *  controller obligation runs to the patient's NEXT asthma visit, which is
   *  data-dependent and computed by the ETL, not a fixed number of days. */
  event_window_days?: number;
  /** CENSORING gate: when this holds, the event is not evaluable because the
   *  DATA CANNOT SHOW the answer — distinct from `event_evaluable_if`, which says
   *  the requirement does not APPLY. Both end in "not evaluable" and they are
   *  different findings: one is a limit on the observation window, the other is
   *  clinical applicability.
   *
   *  Kept a separate expression rather than ANDed into `event_evaluable_if` for
   *  two reasons: the reason string can name the actual limit, and a gate that
   *  reads no event-scoped question is evaluated BEFORE the unanswered check, so
   *  an unjudgeable event says so instead of reporting "nobody looked".
   *
   *  May read the synthetic `_deadline_censored` / `_window_censored` and, when
   *  the censoring is ASYMMETRIC, event answers too: an unobserved tail makes a
   *  NEGATIVE inconclusive while a positive stays conclusive, which is
   *  `_window_censored == true and <the answer> != true`. */
  event_censored_if?: string;
  /** Reason stamped on an event `event_censored_if` caught, in place of the
   *  generic ENGINE_NOT_EVALUABLE_REASON. Recognised as ENGINE-supplied on
   *  re-evaluation like the two sentinels, so a round-tripped event is re-derived
   *  from scratch rather than short-circuiting as an agent-authored reason. */
  event_censored_reason?: string;
  /** question_ids that describe ONE EVENT rather than the observation window.
   *  A patient-level answer for one of these is NEVER inherited into an
   *  event: if the event carries no answer of its own, the question is absent
   *  for that event, so `event_evaluable_if` referencing it fails and the
   *  event is marked not evaluable. Questions absent from this list are
   *  genuinely patient-level and ARE inherited.
   *
   *  Stamped onto every rule by loadAdherenceSkill from the questions'
   *  `event_scoped: true` flag, deliberately rather than being passed as an
   *  option here: when it was implicit, every event inherited the whole-window
   *  answer, so an agent that committed only the rule's own answer per event
   *  had its evaluability decided by the window value — reinstating the
   *  collapse the event model exists to remove, and marking zero events
   *  not-evaluable across a whole run. */
  event_scoped_questions?: string[];
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

/** question_ids this expression tests for ABSENCE (`X is missing` / `X is
 *  present`). A rule that asks whether an answer exists has already decided what
 *  absence means, so the unanswered guard must not overrule it —
 *  R-T1-NoSABAOveruse's `excluded_if: T1-SABAOveruse is missing` is a deliberate
 *  "no medication documentation at all -> leave this patient out". */
function collectAbsenceTested(ast: Ast, into: Set<string>): void {
  switch (ast.kind) {
    case "missing": case "present":
      into.add(ast.qid); break;
    case "compare": case "in": case "truthy":
      break;
    case "not":
      collectAbsenceTested(ast.inner, into); break;
    case "and": case "or":
      collectAbsenceTested(ast.left, into);
      collectAbsenceTested(ast.right, into); break;
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

/** The event-scoped question_ids this rule needs COMMITTED PER EVENT.
 *
 *  Split into the two that matter separately:
 *  - `verdict`: read by `verdict_if` / `excluded_if`. An event missing any of
 *    these cannot be judged at all — without this distinction a missing
 *    answer compares false and the event is scored "the guideline was
 *    violated", turning "nobody looked" into a care gap.
 *  - `evaluability`: read by `event_evaluable_if`. Missing means the
 *    applicability of the requirement at that event is unknown, which the
 *    existing gate already turns into not-evaluable.
 *
 *  Only questions the task marked `event_scoped: true` appear — patient-level
 *  questions are legitimately inherited and must not be demanded per event.
 *  The union is what the event work-list prompt tells the agent to commit;
 *  before it did, the agent had to guess which questions belonged to which
 *  event, and on a live run it answered one event with another event's
 *  question and left four with nothing at all. */
export function eventScopedQuestionsFor(
  rule: RuleDefinition,
): { verdict: string[]; evaluability: string[] } {
  const scoped = new Set(rule.event_scoped_questions ?? []);
  const pick = (srcs: Array<string | undefined>): string[] => {
    const out = new Set<string>();
    for (const src of srcs) {
      if (!src) continue;
      const qids = new Set<string>();
      collectQids(parseExpression(src), qids);
      for (const q of qids) if (scoped.has(q)) out.add(q);
    }
    return [...out].sort();
  };
  return {
    verdict: pick([rule.verdict_if, rule.excluded_if]),
    evaluability: pick([rule.event_evaluable_if]),
  };
}

/** Reason stamped on an anchored event whose rule needs per-event answers the
 *  event does not carry. Distinct from ENGINE_NOT_EVALUABLE_REASON: that one
 *  means "the requirement does not apply here", this one means "we were never
 *  told anything about this event". */
export const ENGINE_UNANSWERED_REASON = "event unanswered (no committed answer for this rule)";

/** The PERIOD-level counterpart. A window rule whose own question was never
 *  answered is UNANSWERED, not violated.
 *
 *  This guard existed for anchored events and not for window rules, and on a live
 *  run that cost a real verdict: the agent committed 12 of 14 period questions,
 *  stopped with "all APPLICABLE adherence questions/events were committed", and
 *  R-T2-ComorbidityAddressed — whose question it had skipped — came out
 *  NON_CONCORDANT, because an absent answer satisfies neither
 *  `verdict_if: == "addressed"` nor `excluded_if: == "not_applicable"`. The
 *  patient's own T1-ComorbidityAssessed said "assessed_and_addressed", so the
 *  reported verdict was the opposite of the right one.
 *
 *  The bias is one-directional: silence always lands on the failing side, never
 *  the passing one, so a lazy or confused extractor pushes the measured adherence
 *  rate DOWN. */
/** Prefix on the rationale of a NON_CONCORDANT verdict the rule could not
 *  attribute. Not a category: a rule that reaches NON_CONCORDANT without
 *  declaring an attribution for that case is incompletely written, and the batch
 *  runner surfaces it rather than filing it under a catch-all. */
export const UNATTRIBUTED_RATIONALE = "rule declares no attribution";

export const ENGINE_PERIOD_UNANSWERED_REASON =
  "question unanswered (the rule's own question was never committed)";

/** Does this entry count as ANSWERED?
 *
 *  A committed entry whose VALUE is null does not. Null means the extractor
 *  looked and could not determine it — or that `coerce()` nulled a value the
 *  rubric no longer allows, which happened this month: a criterion still told
 *  agents to use an enum value that had been deleted, and every such answer
 *  landed as null.
 *
 *  The engine already defines absence this way wherever a rule can test it
 *  directly — `X is missing` is TRUE for a committed null, `X is present` FALSE
 *  (see evalAst) — so keying the two unanswered guards on the question_id alone
 *  contradicted the engine's own definition, and a null slipped past them to be
 *  read as a NEGATIVE by every comparison downstream. Measured on the real
 *  rubric: all 6 window rules with a required question produced a verdict from
 *  an all-null answer set, 5 of them NON_CONCORDANT. The bias is the same
 *  one-directional one as a missing answer — silence lands on the failing side,
 *  pushing measured adherence DOWN. */
export const isAnswered = (a: QuestionAnswer | undefined): boolean =>
  a !== undefined && a.answer !== null && a.answer !== undefined;

/** question_ids a WINDOW rule needs answered before it can be judged: those its
 *  verdict/exclusion expressions read and could actually have been skipped.
 *
 *  Four kinds are excluded, each for its own reason:
 *
 *  - EVENT-SCOPED. A window rule reading one is a rubric error, not a missing
 *    answer, and `event_scoped_questions` has no period answer by construction.
 *  - ABSENCE-TESTED (`X is missing` / `X is present`). The rule has already said
 *    what absence means; overruling it would break, e.g., R-T1-NoSABAOveruse's
 *    deliberate "no medication documentation at all -> leave this patient out".
 *    Exempt from needing a VALUE — but NOT from being committed: see
 *    `absenceTestedQuestions`, which requires an entry so that silence stays
 *    distinguishable from a documented absence.
 *  - DERIVED. Nobody extracts these, so nobody can skip one — their absence is
 *    COMPUTED and load-bearing. The comorbidity gate is written
 *    `excluded_if: T1-WorstControlLevel == "well_controlled"` precisely so that a
 *    patient with no ascertainable control level stays IN the denominator; a
 *    caught unit test showed this guard otherwise inverted that to EXCLUDED.
 *  - SYNTHETIC (`_`-prefixed). Engine-supplied anchor facts, same argument. */
export function periodRequiredQuestions(rule: RuleDefinition): string[] {
  const scoped = new Set(rule.event_scoped_questions ?? []);
  const qids = new Set<string>();
  const absence = new Set<string>();
  for (const src of [rule.verdict_if, rule.excluded_if]) {
    if (!src) continue;
    const ast = parseExpression(src);
    collectQids(ast, qids);
    collectAbsenceTested(ast, absence);
  }
  return [...qids]
    .filter((q) => !scoped.has(q) && !absence.has(q)
      && !DERIVED_QUESTION_IDS.has(q) && !q.startsWith("_"))
    .sort();
}

/** question_ids a rule reads for ABSENCE (`X is missing` / `X is present`) in its
 *  verdict/exclusion expressions, split period vs event-scoped.
 *
 *  These need a COMMITTED ENTRY but not a value. The rule has declared what "no
 *  value" means, so a null there is DATA — what it must not be is silence. An
 *  entry that was never written means nobody looked, and reading that as "absent
 *  from the chart" is the same one-directional bias `isAnswered` closes for every
 *  other question, arriving by a different door.
 *
 *  R-T1-SpirometryWithin24mo is the live case: `verdict_if: T1-SpirometryDate is
 *  present`, attribution DOCUMENTATION_GAP. A chart with no spirometry and a
 *  question the extractor skipped produced the identical care gap, so the rule
 *  could not tell "this child has gone >24 months without spirometry" from "we
 *  never checked". The first is a finding; the second is a hole in the run.
 *
 *  It also sharpens R-T1-NoSABAOveruse, whose `excluded_if: T1-SABAOveruse is
 *  missing` deliberately drops a patient with no medication documentation: that
 *  now requires the extractor to have LOOKED and committed nothing found, rather
 *  than firing on a question nobody answered. Same declared behavior, no longer
 *  reachable by silence.
 *
 *  DERIVED and synthetic (`_`-prefixed) ids are excluded for the same reason
 *  periodRequiredQuestions excludes them: nobody extracts them, so nobody can
 *  skip one, and their absence is computed and load-bearing. */
export function absenceTestedQuestions(
  rule: RuleDefinition,
): { period: string[]; event: string[] } {
  const scoped = new Set(rule.event_scoped_questions ?? []);
  const absence = new Set<string>();
  for (const src of [rule.verdict_if, rule.excluded_if]) {
    if (!src) continue;
    collectAbsenceTested(parseExpression(src), absence);
  }
  const keep = [...absence].filter((q) => !DERIVED_QUESTION_IDS.has(q) && !q.startsWith("_"));
  return {
    period: keep.filter((q) => !scoped.has(q)).sort(),
    event: keep.filter((q) => scoped.has(q)).sort(),
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
  // NO "OTHER" FALLBACK. A NON_CONCORDANT verdict the rule cannot attribute is a
  // RULE BUG — an attribution_when whose branches do not cover the case, or a
  // missing constant `attribution` — and both real occurrences of the old
  // fallback came from the same defect: an input that was never answered, which
  // now has its own state. Filing it as a category disguised the bug as data.
  // Left undefined and reported, so it reads as "this rule did not say", which
  // is what happened.
  return {
    rule_id: compiled.rule.rule_id,
    verdict: "NON_CONCORDANT",
    ...(attribution ? { attribution } : {}),
    ...(attribution ? {} : {
      rationale: `${UNATTRIBUTED_RATIONALE}: ${compiled.rule.rule_id} reached `
        + "NON_CONCORDANT but declares no attribution for this case",
    }),
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

/** Answer list for one event.
 *
 *  Patient-level answers are inherited ONLY for questions that describe the
 *  whole observation window. A question listed in `eventScoped` describes one
 *  event, so its patient-level answer is withheld: if the event carries no
 *  answer of its own the question is simply absent here, and an
 *  `event_evaluable_if` that reads it fails (an absent question_id compares
 *  false), marking the event not evaluable rather than judging it on the
 *  window value.
 *
 *  `_anchor_type`, `_deadline_censored` and `_window_censored` are reserved
 *  synthetic question_ids — a real question authored with any of them would be
 *  shadowed by the synthetic value. They let `event_evaluable_if` /
 *  `event_censored_if` read facts about the event itself that no extraction could
 *  supply: which anchor list produced it, whether its judgment deadline was
 *  truncated at the end of observation, and whether the rule's declared judgment
 *  span runs past that end. */
function mergedAnswers(
  patient: QuestionAnswer[],
  event: RuleEvent,
  eventScoped: ReadonlySet<string>,
  windowDays?: number,
): QuestionAnswer[] {
  // A window stub IS the observation window, so every patient-level answer is
  // in scope for it — withholding them there would break the anchor-free
  // rules whose behavior must stay byte-identical.
  const withhold = event.anchor.type === WINDOW_ANCHOR_TYPE ? new Set<string>() : eventScoped;
  const map = new Map<string, QuestionAnswer>();
  for (const a of patient) {
    if (withhold.has(a.question_id)) continue;
    map.set(a.question_id, a);
  }
  for (const a of event.answers ?? []) map.set(a.question_id, a);
  map.set("_anchor_type", { question_id: "_anchor_type", tier: -1, answer: event.anchor.type });
  // The care SETTING of this anchor ("outpatient" | "ed"), so a rule can state
  // its own scope instead of taking whatever the anchor list happens to hold.
  // Two rules need it: stepping up daily controller therapy is a LONGITUDINAL
  // OUTPATIENT decision, and scoring that gap against an ED encounter both
  // double-counts the visit (already an exacerbation, already a follow-up
  // trigger) and files it against a clinician whose task was acute
  // stabilisation. Post-ED follow-up IS a guideline requirement, so
  // R-T2-FollowupScheduled deliberately keeps ED anchors.
  // Absent -> null, which is not "ed": an anchor list with no setting concept
  // (ocs_bursts) and an extract predating the field both keep their behaviour,
  // the same convention `_window_censored` follows below.
  map.set("_anchor_kind", {
    question_id: "_anchor_kind", tier: -1,
    answer: (event.anchor.meta?.kind as string | undefined) ?? null,
  });
  map.set("_deadline_censored", {
    question_id: "_deadline_censored", tier: -1,
    answer: event.anchor.meta?.deadline_censored === true,
  });
  // Does the rule's declared judgment span run past the end of observation? The
  // ETL stamps `days_to_index` (index_date minus the anchor date) because only it
  // knows the index date; the span comes from the rule, so only the engine can
  // put the two together. Undefined either side -> false: absent information is
  // not evidence of censoring, and an extract predating the field keeps its
  // behaviour.
  const daysToIndex = event.anchor.meta?.days_to_index;
  map.set("_window_censored", {
    question_id: "_window_censored", tier: -1,
    answer: typeof windowDays === "number" && typeof daysToIndex === "number"
      && daysToIndex < windowDays,
  });
  return [...map.values()];
}

export interface RuleEventsResult {
  rule_events: RuleEvent[];
  rule_rollups: RuleRollup[];
  /** Period verdicts mirrored from the rollups — same shape existing
   *  consumers (AdherenceReview, compare.py, IAA) already read. */
  rule_verdicts: RuleVerdict[];
  /** Patient-level answers the engine COMPUTED from the events this pass (see
   *  `withDerivedAnswers`). Returned so the caller can persist them alongside
   *  the extracted answers: the reviewer needs to see the value a rule's
   *  applicability gate actually read, and recomputing it in the client would
   *  be a second implementation of the same reduction. */
  derived_answers: QuestionAnswer[];
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

// ── Derived patient-level answers ────────────────────────────────────────────
//
// Some requirements have an EVENT-LEVEL TRIGGER but a WINDOW-LEVEL ACTION:
// comorbidity workup and specialty referral are indicated by how controlled
// the asthma was (which is judged per visit, and can differ across visits),
// yet the action itself is done once and covers the whole period — you don't
// redo an allergy workup at every uncontrolled visit.
//
// Those rules therefore stay patient-level, but their applicability gate can no
// longer read `T1-ControlLevel`: after the event split that question has one
// answer PER VISIT, and a patient can be well controlled in March, uncontrolled
// in July and well controlled again in November. The old instruction ("answer
// not_applicable when T1-ControlLevel == well_controlled") had nothing to say
// about which of the three governs, so two annotators would legitimately
// disagree on whether the patient counts at all — an inter-rater split on the
// DENOMINATOR, the most expensive kind.
//
// The engine reduces the per-event answers to one value instead of asking a
// human to do it: the WORST control level seen at any event in the period.
// EPR-3's own wording is the reason — comorbidity workup is indicated for
// "asthma that CANNOT be well controlled", and a year with an uncontrolled
// stretch is a year where it could not be. Taking the most recent event
// instead would let a patient who spent mid-year uncontrolled escape the
// requirement because the last visit happened to look fine, and the patients
// excused that way are exactly the ones most likely to have failed — the
// reported adherence rate would rise for a reason that isn't care.

/** question_id of the engine-computed worst-control-level value. Not a question
 *  in references/questions/*.yaml: nobody extracts it, `list_questions` never
 *  offers it, and `set_question_answer` rejects it as unknown. Rules read it
 *  from `excluded_if` like any other id. */
export const DERIVED_WORST_CONTROL_QID = "T1-WorstControlLevel";

/** Every question_id the ENGINE produces rather than an extractor. Absence of one
 *  is a computed fact, never a skipped question, so the period-unanswered guard
 *  must not read it as an omission. */
export const DERIVED_QUESTION_IDS: ReadonlySet<string> = new Set([DERIVED_WORST_CONTROL_QID]);

/** The per-event question the derived value is computed from. */
const CONTROL_LEVEL_QID = "T1-ControlLevel";

/** Ordering for "worst". `undetermined` is deliberately absent — it is not a
 *  degree of control, it means the chart could not establish one, so it never
 *  wins the max and never masks a real level recorded elsewhere. */
const CONTROL_LEVEL_SEVERITY: Record<string, number> = {
  well_controlled: 1,
  not_well_controlled: 2,
  very_poorly_controlled: 3,
};

/** Worst control level committed at any event, or null when no event carries a
 *  determinable one.
 *
 *  Null (rather than a defaulted "well_controlled") is load-bearing: the gates
 *  are written `excluded_if: <derived> == "well_controlled"`, so null leaves the
 *  patient IN the denominator and the requirement in force. That matches the
 *  v0.5 instruction it replaces ("when T1-ControlLevel is undetermined, do NOT
 *  answer not_applicable — still record what the chart documents"), and it fails
 *  toward measuring rather than toward silently dropping patients.
 *
 *  A HUMAN'S STRIKE IS HONOURED; THE ENGINE'S APPLICABILITY GATE IS NOT.
 *
 *  This used to read every event's answers regardless of `evaluable`, so an event
 *  a reviewer had explicitly struck still decided the denominator — measured on 20
 *  stored patients, and in all 20 the struck event moved the derived value across
 *  `R-T1-ComorbidityAssessedWhenUncontrolled`'s `well_controlled` exclusion line,
 *  flipping that rule between EXCLUDED and judged. That is the reviewer's
 *  judgment being discarded, the same defect as the `evaluable:true` one, and it
 *  is fixed the same way: the human holds (study lead, 2026-09-03).
 *
 *  But "skip every non-evaluable event" would be WRONG, and wrong in the
 *  gap-inflating direction. Most non-evaluability here is the engine's own
 *  applicability gate, and for the controller rule that gate is
 *  `T1-ControlLevel in ["not_well_controlled", "very_poorly_controlled"]` — so
 *  its non-evaluable events are exactly the WELL-CONTROLLED visits. Dropping
 *  those would systematically delete the well-controlled observations from a MAX,
 *  pushing the derived worst upward, keeping more patients in the comorbidity
 *  denominator and reporting more gaps. A censored event is the same: the
 *  observation happened, only the judgment window was truncated.
 *
 *  So the test is WHO said not-evaluable, not THAT it is not evaluable. A
 *  reviewer's strike (source "reviewer" + `evaluable: false`) says "this is not a
 *  real judgment point", which applies to its annotation too. An engine sentinel
 *  says only "this rule does not reach this visit", which says nothing about
 *  whether the visit was observed. */
export function deriveWorstControlLevel(events: RuleEvent[]): string | null {
  let worst: string | null = null;
  let severity = 0;
  for (const e of events) {
    if (e.evaluable === false && e.source === "reviewer") continue;
    for (const a of e.answers ?? []) {
      if (a.question_id !== CONTROL_LEVEL_QID) continue;
      const s = CONTROL_LEVEL_SEVERITY[String(a.answer)];
      if (s !== undefined && s > severity) { severity = s; worst = String(a.answer); }
    }
  }
  return worst;
}

/** `patientAnswers` plus the derived answers computed from `events`.
 *
 *  Any stale derived entry already in `patientAnswers` is dropped first, so a
 *  re-evaluation after a reviewer edits an event's control level cannot read a
 *  value computed from the pre-edit events. */
export function withDerivedAnswers(
  patientAnswers: QuestionAnswer[],
  events: RuleEvent[],
): QuestionAnswer[] {
  const out = patientAnswers.filter((a) => a.question_id !== DERIVED_WORST_CONTROL_QID);
  const worst = deriveWorstControlLevel(events);
  if (worst !== null) {
    out.push({
      question_id: DERIVED_WORST_CONTROL_QID,
      tier: 1,
      answer: worst,
      source: "derived",
      reasoning: `worst T1-ControlLevel across ${events.filter((e) =>
        (e.answers ?? []).some((a) => a.question_id === CONTROL_LEVEL_QID)).length} event(s)`,
      ts: new Date().toISOString(),
    });
  }
  return out;
}

/** The rules whose expressions read `qid` — used by the incremental
 *  re-evaluation path to find which rules a derived-input change invalidates,
 *  rather than hard-coding the dependency at the call site. Rules that fail to
 *  compile are skipped (they get their own compile-error containment during
 *  evaluation). */
/** Every question_id this rule's expressions actually READ — verdict, exclusion,
 *  event applicability, censoring, and the attribution arms.
 *
 *  `supporting_questions` is a hand-written DECLARATION and it drifts: the pane
 *  renders it as the rule's "Inputs:" row, so a reviewer is shown a list of what
 *  supposedly decides the verdict while the engine reads something else. On the
 *  v0.6 rubric four of twelve rules disagreed, in both directions —
 *  R-T2-StepTherapyMatches read T1-ControlLevel WITHOUT declaring it (the input
 *  that decides whether the rule applies at all was invisible to the reviewer),
 *  and R-T1-ControllerForPersistent declared a control level it never read, which
 *  is how a whole missing rule arm hid in plain sight for weeks.
 *
 *  Synthetic (`_`-prefixed) ids are dropped: they are engine-supplied anchor
 *  facts, not questions anybody answers. A malformed expression contributes
 *  nothing rather than throwing — a rule that fails to compile is reported as a
 *  compile error elsewhere, and this must stay usable for display. */
export function questionsReadBy(rule: RuleDefinition): string[] {
  const out = new Set<string>();
  const sources = [
    rule.verdict_if, rule.excluded_if, rule.event_evaluable_if, rule.event_censored_if,
    ...(rule.attribution_when ?? []).map((aw) => aw.when),
  ];
  for (const src of sources) {
    if (!src) continue;
    try { collectQids(parseExpression(src), out); } catch { /* see above */ }
  }
  return [...out].filter((q) => !q.startsWith("_")).sort();
}

export function rulesReadingQid(
  rules: RuleDefinition[],
  qid: string,
): RuleDefinition[] {
  return rules.filter((r) => {
    try {
      if (compileRule(r).qids.includes(qid)) return true;
      return r.event_evaluable_if
        ? compileRule({ ...r, verdict_if: r.event_evaluable_if }).qids.includes(qid)
        : false;
    } catch { return false; }
  });
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
  const censoredAst = rule.event_censored_if
    ? parseExpression(rule.event_censored_if)
    : null;
  const eventScoped = new Set(rule.event_scoped_questions ?? []);
  const scopedFor = eventScopedQuestionsFor(rule);
  const required = scopedFor.verdict;
  const periodRequired = periodRequiredQuestions(rule);
  // Two levels of "answered". A question the rule compares a VALUE to needs one
  // (isAnswered); a question it tests for ABSENCE needs only a committed entry,
  // because the rule itself says what no-value means — but silence is still not
  // an answer. See absenceTestedQuestions.
  const absenceTested = absenceTestedQuestions(rule);
  const absenceEvent = new Set(absenceTested.event);
  // Can the CENSORING gate be decided without any per-event answer? True when it
  // reads only patient-level answers and the synthetic anchor facts. Such a gate
  // runs BEFORE the unanswered check, or an unanswered unjudgeable event reports
  // "nobody looked" when the truth is "the data cannot show this" — a different
  // finding and the more important one. An ASYMMETRIC censoring gate (a positive
  // stays conclusive, a negative does not) necessarily reads the answer, so it
  // runs after, where the answer exists.
  const censoringIsStructural = censoredAst
    && eventScopedQuestionsFor({ ...rule, verdict_if: rule.event_censored_if! })
      .verdict.length === 0;

  const outEvents: RuleEvent[] = events.map((e) => {
    // Reasons the ENGINE could itself have produced for THIS rule. Any other
    // reason is agent- or reviewer-authored and authoritative: it short-circuits
    // rather than being re-derived. Without rule.event_censored_reason in this
    // set, a custom reason would freeze the event at the first pass.
    if (e.evaluable === false
        && e.evaluable_reason !== ENGINE_NOT_EVALUABLE_REASON
        && e.evaluable_reason !== ENGINE_UNANSWERED_REASON
        // Prefix match: the period reason appends the missing question_ids.
        && !e.evaluable_reason?.startsWith(ENGINE_PERIOD_UNANSWERED_REASON)
        && e.evaluable_reason !== rule.event_censored_reason) {
      return { ...e, verdict: undefined, attribution: undefined };
    }
    const notEvaluable = (reason?: string): RuleEvent => ({
      ...e,
      evaluable: false,
      evaluable_reason: e.evaluable_reason ?? reason ?? ENGINE_NOT_EVALUABLE_REASON,
      verdict: undefined,
      attribution: undefined,
    });
    const holds = (ast: Ast | null, answers: QuestionAnswer[]) =>
      !ast || evalAst(ast, new Map(answers.map((a) => [a.question_id, a])));
    const censored = (answers: QuestionAnswer[]) =>
      !!censoredAst && holds(censoredAst, answers);

    if (censoringIsStructural
        && censored(mergedAnswers(patientAnswers, e, eventScoped, rule.event_window_days))) {
      return notEvaluable(rule.event_censored_reason);
    }
    // An anchored event whose rule needs per-event answers, but which carries
    // none of them, is UNANSWERED — not concordant, not violated. Deriving a
    // verdict here reads a missing answer as false and reports a care gap
    // nobody established: on a live run an event with an empty answer list was
    // scored NON_CONCORDANT purely because the question was absent.
    if (e.anchor.type !== WINDOW_ANCHOR_TYPE && required.length > 0) {
      // isAnswered, not presence: a committed null is not an answer — unless the
      // rule tests this question for absence, where an entry is enough.
      const own = new Set((e.answers ?? []).filter(isAnswered).map((a) => a.question_id));
      const ownEntries = new Set((e.answers ?? []).map((a) => a.question_id));
      if (!required.every((q) => (absenceEvent.has(q) ? ownEntries.has(q) : own.has(q)))) {
        return {
          ...e,
          evaluable: false,
          evaluable_reason: ENGINE_UNANSWERED_REASON,
          verdict: undefined,
          attribution: undefined,
        };
      }
    }
    // The window stub's counterpart. Used to be exempt on the grounds that it
    // "legitimately reads patient-level answers" — true, and beside the point:
    // reading one that was never committed is exactly the case this catches. See
    // ENGINE_PERIOD_UNANSWERED_REASON for the verdict it cost.
    if (e.anchor.type === WINDOW_ANCHOR_TYPE
        && (periodRequired.length > 0 || absenceTested.period.length > 0)) {
      const have = new Set(patientAnswers.filter(isAnswered).map((a) => a.question_id));
      const committed = new Set(patientAnswers.map((a) => a.question_id));
      // "(null)" distinguishes "committed, but with no value" from "never
      // committed" — the reviewer needs to know whether anybody looked. The
      // CONSTANT's own text stays byte-stable: stored states carry it, and the
      // short-circuit above matches on it, so an edit would freeze every
      // already-persisted unanswered event as if a human had authored it.
      const missing = [
        ...periodRequired.filter((q) => !have.has(q))
          .map((q) => (committed.has(q) ? `${q} (null)` : q)),
        // Absence-tested: only silence counts as missing here.
        ...absenceTested.period.filter((q) => !committed.has(q)),
      ].sort();
      if (missing.length > 0) {
        return {
          ...e,
          evaluable: false,
          evaluable_reason: `${ENGINE_PERIOD_UNANSWERED_REASON}: ${missing.join(", ")}`,
          verdict: undefined,
          attribution: undefined,
        };
      }
    }
    const merged = mergedAnswers(patientAnswers, e, eventScoped, rule.event_window_days);
    // Applicability BEFORE censoring: an event the requirement does not apply to
    // is not "censored", and saying so would misreport why it left the
    // denominator.
    //
    if (!holds(evaluableAst, merged)) return notEvaluable();
    if (!censoringIsStructural && censored(merged)) {
      return notEvaluable(rule.event_censored_reason);
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
  // Derived patient-level values first: a rule's applicability gate may read
  // one (see DERIVED_WORST_CONTROL_QID), and it is computed from ALL the events
  // in this pass — so a caller re-evaluating a single rule must still hand in
  // the patient's full event list, not just that rule's.
  const answers = withDerivedAnswers(patientAnswers, events);
  const derivedAnswers = answers.filter((a) => a.source === "derived");
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
      const { events: evs, rollup, qids } = evaluateRuleEvents(rule, answers, ruleEvents);
      allEvents.push(...evs);
      rollups.push(rollup);
      // A rule that left the denominator because nobody answered its question is
      // not the same as one the guideline does not apply to, and both roll up to
      // EXCLUDED. The reason rides along on the verdict so a reader (UI, IAA,
      // compare) can tell them apart without walking rule_events, and so
      // "questions the extractor skipped" is countable.
      const unanswered = evs.find((x) =>
        x.evaluable === false
        && x.evaluable_reason?.startsWith(ENGINE_PERIOD_UNANSWERED_REASON));
      verdicts.push({
        rule_id: rule.rule_id,
        verdict: rollup.period_verdict,
        // Same as the single-rule path: no catch-all. A rollup that reached
        // NON_CONCORDANT without an attribution means the rule did not declare
        // one for that case.
        ...(rollup.period_verdict === "NON_CONCORDANT" && rollup.period_attribution
          ? { attribution: rollup.period_attribution }
          : {}),
        ...(rollup.period_verdict === "NON_CONCORDANT" && !rollup.period_attribution
          ? { rationale: `${UNATTRIBUTED_RATIONALE}: ${rule.rule_id}` }
          : {}),
        ...(unanswered ? { rationale: unanswered.evaluable_reason } : {}),
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
  return {
    rule_events: allEvents, rule_rollups: rollups, rule_verdicts: verdicts,
    derived_answers: derivedAnswers,
  };
}
