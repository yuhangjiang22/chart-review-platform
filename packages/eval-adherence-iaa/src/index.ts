/**
 * Inter-annotator agreement for adherence tasks.
 *
 * Two surfaces:
 *
 *   1. Per-question agreement — pair agent vs reviewer
 *      QuestionAnswer.answer by question_id × patient_id, compute
 *      Cohen's κ (categorical/boolean) or |Δ| ≤ tolerance accuracy
 *      (numeric/date) per question. Macro across questions is the
 *      "questions κ" headline.
 *   2. Per-rule agreement — pair agent vs reviewer
 *      RuleVerdict.verdict by rule_id × patient_id, compute Cohen's κ
 *      over the {CONCORDANT, NON_CONCORDANT, EXCLUDED} alphabet. Macro
 *      across rules is the "rules κ" headline that gates LOCK.
 *
 * Both surfaces share the simple Cohen's κ implementation in this
 * file (kept local to keep package dependencies minimal — the kappa
 * package's API is replay-based and doesn't fit the QA/Verdict
 * shape).
 *
 * Pure / deterministic / no I/O — same shape as eval-span-iaa.
 */

import type { QuestionAnswer, RuleVerdict } from "@chart-review/platform-types";

// ── Cohen's κ over a discrete alphabet ──────────────────────────────────────

export interface KappaCell {
  rater_a: string;
  rater_b: string;
}

/**
 * Cohen's κ over paired categorical observations. Each cell is
 * `{ rater_a, rater_b }`; alphabet is derived from the observed
 * values. Returns κ ∈ [-1, 1] (1 = perfect agreement). NaN when there
 * are < 2 pairs.
 */
export function cohensKappa(cells: KappaCell[]): number {
  if (cells.length < 2) return Number.NaN;
  const labels = new Set<string>();
  for (const c of cells) { labels.add(c.rater_a); labels.add(c.rater_b); }
  const labelArr = [...labels].sort();
  if (labelArr.length < 2) return 1; // every cell agrees on one label
  const idx = new Map(labelArr.map((l, i) => [l, i] as const));
  const matrix: number[][] = labelArr.map(() => labelArr.map(() => 0));
  for (const c of cells) {
    matrix[idx.get(c.rater_a)!]![idx.get(c.rater_b)!]!++;
  }
  const n = cells.length;
  let observedAgree = 0;
  for (let i = 0; i < labelArr.length; i++) observedAgree += matrix[i]![i]!;
  const pObs = observedAgree / n;
  let pExp = 0;
  for (let i = 0; i < labelArr.length; i++) {
    let rowSum = 0, colSum = 0;
    for (let j = 0; j < labelArr.length; j++) {
      rowSum += matrix[i]![j]!;
      colSum += matrix[j]![i]!;
    }
    pExp += (rowSum / n) * (colSum / n);
  }
  if (pExp === 1) return 1;
  return (pObs - pExp) / (1 - pExp);
}

// ── Per-question agreement ──────────────────────────────────────────────────

export interface PerQuestionMetrics {
  question_id: string;
  /** Tier copied from the answers (for UI grouping). */
  tier?: number;
  /** Cohen's κ when both answers are discrete. NaN when not
   *  applicable (e.g. < 2 pairs or numeric tolerance mode). */
  kappa: number;
  /** Fraction of pairs where rater_a == rater_b (or |Δ| ≤ tolerance
   *  for numeric questions). */
  agreement: number;
  /** Pairs counted. */
  n: number;
}

export interface PerQuestionIaaOpts {
  /** Numeric questions use |Δ| ≤ numeric_tolerance instead of κ. The
   *  agreement field becomes "fraction within tolerance". Default 0
   *  (exact match required). */
  numeric_tolerance?: number;
  /** When true, pairs where either side answered `null` are treated
   *  as MISSING and counted as disagreement when only one side is
   *  null, agreement when both are null. Default true. */
  count_missing?: boolean;
}

interface QuestionPair {
  patient_id: string;
  question_id: string;
  agent: QuestionAnswer["answer"];
  reviewer: QuestionAnswer["answer"];
  tier?: number;
}

function pairQuestions(
  agentByPatient: Map<string, QuestionAnswer[]>,
  reviewerByPatient: Map<string, QuestionAnswer[]>,
): QuestionPair[] {
  const out: QuestionPair[] = [];
  const patients = new Set([...agentByPatient.keys(), ...reviewerByPatient.keys()]);
  for (const pid of patients) {
    const agentIdx = new Map<string, QuestionAnswer>();
    for (const a of agentByPatient.get(pid) ?? []) agentIdx.set(a.question_id, a);
    const reviewerIdx = new Map<string, QuestionAnswer>();
    for (const a of reviewerByPatient.get(pid) ?? []) reviewerIdx.set(a.question_id, a);
    const qids = new Set([...agentIdx.keys(), ...reviewerIdx.keys()]);
    for (const qid of qids) {
      const a = agentIdx.get(qid);
      const r = reviewerIdx.get(qid);
      out.push({
        patient_id: pid,
        question_id: qid,
        agent: a?.answer ?? null,
        reviewer: r?.answer ?? null,
        tier: r?.tier ?? a?.tier,
      });
    }
  }
  return out;
}

function isNumeric(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function computePerQuestionMetrics(
  pairs: QuestionPair[],
  opts: PerQuestionIaaOpts = {},
): PerQuestionMetrics[] {
  const countMissing = opts.count_missing ?? true;
  const tol = opts.numeric_tolerance ?? 0;

  const byQid = new Map<string, QuestionPair[]>();
  for (const p of pairs) {
    const arr = byQid.get(p.question_id) ?? [];
    arr.push(p);
    byQid.set(p.question_id, arr);
  }

  const out: PerQuestionMetrics[] = [];
  for (const [qid, qs] of byQid) {
    // Numeric branch: tolerance-based accuracy, κ left NaN.
    const looksNumeric = qs.some((p) => isNumeric(p.agent) || isNumeric(p.reviewer));
    if (looksNumeric) {
      let n = 0, ok = 0;
      for (const p of qs) {
        if (p.agent === null && p.reviewer === null) {
          if (!countMissing) continue;
          n++; ok++; continue;
        }
        if (p.agent === null || p.reviewer === null) {
          if (!countMissing) continue;
          n++; continue;
        }
        if (isNumeric(p.agent) && isNumeric(p.reviewer)) {
          n++;
          if (Math.abs(p.agent - p.reviewer) <= tol) ok++;
        } else {
          n++;
          if (p.agent === p.reviewer) ok++;
        }
      }
      out.push({
        question_id: qid,
        tier: qs[0]?.tier,
        kappa: Number.NaN,
        agreement: n > 0 ? ok / n : Number.NaN,
        n,
      });
      continue;
    }
    // Discrete branch: Cohen's κ.
    const cells: KappaCell[] = [];
    let observedAgree = 0;
    let counted = 0;
    for (const p of qs) {
      const aMissing = p.agent === null || p.agent === undefined;
      const rMissing = p.reviewer === null || p.reviewer === undefined;
      if (!countMissing && (aMissing || rMissing)) continue;
      const aLabel = aMissing ? "__MISSING__" : String(p.agent);
      const rLabel = rMissing ? "__MISSING__" : String(p.reviewer);
      cells.push({ rater_a: aLabel, rater_b: rLabel });
      counted++;
      if (aLabel === rLabel) observedAgree++;
    }
    out.push({
      question_id: qid,
      tier: qs[0]?.tier,
      kappa: cohensKappa(cells),
      agreement: counted > 0 ? observedAgree / counted : Number.NaN,
      n: counted,
    });
  }
  return out;
}

// ── Per-rule agreement ──────────────────────────────────────────────────────

export interface PerRuleMetrics {
  rule_id: string;
  kappa: number;
  agreement: number;
  n: number;
  /** Disagreement breakdown for triage UI. */
  disagreements: {
    agent: RuleVerdict["verdict"];
    reviewer: RuleVerdict["verdict"];
    patient_id: string;
  }[];
}

interface RulePair {
  patient_id: string;
  rule_id: string;
  agent: RuleVerdict["verdict"];
  reviewer: RuleVerdict["verdict"];
}

function pairRules(
  agentByPatient: Map<string, RuleVerdict[]>,
  reviewerByPatient: Map<string, RuleVerdict[]>,
): RulePair[] {
  const out: RulePair[] = [];
  const patients = new Set([...agentByPatient.keys(), ...reviewerByPatient.keys()]);
  for (const pid of patients) {
    const agentIdx = new Map<string, RuleVerdict>();
    for (const v of agentByPatient.get(pid) ?? []) agentIdx.set(v.rule_id, v);
    const reviewerIdx = new Map<string, RuleVerdict>();
    for (const v of reviewerByPatient.get(pid) ?? []) reviewerIdx.set(v.rule_id, v);
    const rids = new Set([...agentIdx.keys(), ...reviewerIdx.keys()]);
    for (const rid of rids) {
      const a = agentIdx.get(rid);
      const r = reviewerIdx.get(rid);
      if (!a || !r) continue;
      out.push({ patient_id: pid, rule_id: rid, agent: a.verdict, reviewer: r.verdict });
    }
  }
  return out;
}

export function computePerRuleMetrics(pairs: RulePair[]): PerRuleMetrics[] {
  const byRid = new Map<string, RulePair[]>();
  for (const p of pairs) {
    const arr = byRid.get(p.rule_id) ?? [];
    arr.push(p);
    byRid.set(p.rule_id, arr);
  }
  const out: PerRuleMetrics[] = [];
  for (const [rid, rs] of byRid) {
    const cells: KappaCell[] = rs.map((p) => ({ rater_a: p.agent, rater_b: p.reviewer }));
    let agree = 0;
    const disagreements: PerRuleMetrics["disagreements"] = [];
    for (const p of rs) {
      if (p.agent === p.reviewer) agree++;
      else disagreements.push({ agent: p.agent, reviewer: p.reviewer, patient_id: p.patient_id });
    }
    out.push({
      rule_id: rid,
      kappa: cohensKappa(cells),
      agreement: rs.length > 0 ? agree / rs.length : Number.NaN,
      n: rs.length,
      disagreements,
    });
  }
  return out;
}

// ── Public API: full report ─────────────────────────────────────────────────

export interface AdherenceIaaReport {
  per_question: PerQuestionMetrics[];
  per_rule: PerRuleMetrics[];
  /** Macro across discrete questions (numeric questions excluded
   *  because their κ is NaN). NaN when every question is numeric. */
  questions_kappa_macro: number;
  /** Macro across rules. The LOCK gate compares this to a threshold
   *  (Phase 3 wiring). NaN when no rules paired. */
  rules_kappa_macro: number;
}

export interface AdherenceIaaInput {
  /** patient_id → agent's QuestionAnswer[] for that patient. */
  agent_question_answers: Map<string, QuestionAnswer[]>;
  /** patient_id → reviewer's QuestionAnswer[] for that patient. */
  reviewer_question_answers: Map<string, QuestionAnswer[]>;
  /** patient_id → agent's RuleVerdict[]. */
  agent_rule_verdicts: Map<string, RuleVerdict[]>;
  /** patient_id → reviewer's RuleVerdict[]. */
  reviewer_rule_verdicts: Map<string, RuleVerdict[]>;
  question_opts?: PerQuestionIaaOpts;
}

function macroOver(metrics: Array<{ kappa: number }>): number {
  const valid = metrics.map((m) => m.kappa).filter((k) => Number.isFinite(k));
  if (valid.length === 0) return Number.NaN;
  return valid.reduce((s, k) => s + k, 0) / valid.length;
}

export function computeAdherenceIaa(input: AdherenceIaaInput): AdherenceIaaReport {
  const qPairs = pairQuestions(input.agent_question_answers, input.reviewer_question_answers);
  const rPairs = pairRules(input.agent_rule_verdicts, input.reviewer_rule_verdicts);
  const per_question = computePerQuestionMetrics(qPairs, input.question_opts);
  const per_rule = computePerRuleMetrics(rPairs);
  return {
    per_question,
    per_rule,
    questions_kappa_macro: macroOver(per_question),
    rules_kappa_macro: macroOver(per_rule),
  };
}

// ── Per-event agreement ──────────────────────────────────────────────────────
//
// Third surface, added for the event-concordance timeline (spec
// 2026-08-24, Task 7). Pairs agent vs reviewer RuleEvent[] — flattened to
// EventSide[] by the caller — by `${patient_id}|${event_id}`. Two axes,
// reported separately (plan ERRATA, Task 6 re-review):
//
//   1. Enumeration — did both sides produce the same anchored events at
//      all? Window-rule stubs (anchor.type === "window", no date) are
//      constants present on both sides by construction and are never
//      rendered as comparable timeline cards, so they are excluded from
//      matched/a_only/b_only/jaccard and reported separately as
//      `window_rules`.
//   2. Verdict agreement — for MATCHED keys (from either population),
//      do the two sides' verdict labels agree? A present-but-unscored
//      event (no verdict yet — a seeded stub the annotator hasn't
//      reached) is label "NONE", distinct from an event the agent
//      explicitly judged NOT_EVALUABLE. Both are scored as verdict
//      disagreements against a differently-labeled counterpart, but
//      neither is ever an enumeration miss — the KEY existed on both
//      sides, only the label differs.

/** One side's view of one event, flattened for comparison. */
export interface EventSide {
  patient_id: string;
  event_id: string;
  rule_id: string;
  /** anchor.type !== "window" && anchor.date — window stubs are constants on
   *  both sides and are reported separately, never inside the enumeration
   *  counts (plan ERRATA, Task 6 re-review). */
  anchored: boolean;
  verdict?: "CONCORDANT" | "NON_CONCORDANT" | "EXCLUDED";
  evaluable?: boolean;
}

export interface PerEventRuleMetrics {
  rule_id: string;
  n_matched: number;
  verdict_agreement: number;
  a_only: number;
  b_only: number;
}

export interface PerEventReport {
  per_rule: PerEventRuleMetrics[];
  verdict_kappa: number;
  enumeration: { matched: number; a_only: number; b_only: number; jaccard: number };
  /** Window-scoped events seen (max of the two sides) — reported, not scored. */
  window_rules: number;
}

interface EventKeyed {
  key: string;
  rule_id: string;
  anchored: boolean;
  side: EventSide;
}

function keyOf(e: EventSide): string {
  return `${e.patient_id}|${e.event_id}`;
}

function labelOf(e: EventSide): string {
  return e.evaluable === false ? "NOT_EVALUABLE" : e.verdict ?? "NONE";
}

function indexEvents(events: EventSide[]): Map<string, EventKeyed> {
  const idx = new Map<string, EventKeyed>();
  for (const e of events) {
    idx.set(keyOf(e), { key: keyOf(e), rule_id: e.rule_id, anchored: e.anchored, side: e });
  }
  return idx;
}

/**
 * Per-event inter-annotator agreement. Pairs two flattened event lists
 * (agent vs reviewer, or any two annotation sides) by
 * `${patient_id}|${event_id}` and reports enumeration + verdict-agreement
 * axes separately. Both axes — global `verdict_kappa` and each rule's
 * `n_matched`/`verdict_agreement`/`a_only`/`b_only` — are scoped to
 * ANCHORED events only; window-rule stubs never touch those counters, they
 * only bump `window_rules`. `per_rule` still lists every rule_id seen on
 * either side (a pure-window rule gets a zeroed row, not an absent one).
 * Pure / deterministic / no I/O — same shape as computePerRuleMetrics
 * above.
 */
export function computePerEventMetrics(a: EventSide[], b: EventSide[]): PerEventReport {
  const aIdx = indexEvents(a);
  const bIdx = indexEvents(b);
  const allKeys = new Set([...aIdx.keys(), ...bIdx.keys()]);

  let enumMatched = 0, enumAOnly = 0, enumBOnly = 0;
  // Distinct non-anchored keys seen (union across sides — window stubs are
  // constants on both sides by construction, so this equals "max across
  // sides" in practice).
  const windowKeys = new Set<string>();
  const kappaCells: KappaCell[] = [];

  const byRule = new Map<string, { matched: KappaCell[]; a_only: number; b_only: number }>();
  const ensureRule = (rid: string) => {
    let r = byRule.get(rid);
    if (!r) { r = { matched: [], a_only: 0, b_only: 0 }; byRule.set(rid, r); }
    return r;
  };
  // Seed a per_rule row for every rule_id seen on either side, even one
  // whose events are all window-scoped (zero anchored counts is still a
  // row, not an absence).
  for (const e of a) ensureRule(e.rule_id);
  for (const e of b) ensureRule(e.rule_id);

  for (const key of allKeys) {
    const av = aIdx.get(key);
    const bv = bIdx.get(key);
    const ruleId = (av?.rule_id ?? bv?.rule_id)!;
    const anchored = (av?.anchored ?? bv?.anchored) === true;

    if (!anchored) {
      // Window stub: counted only in window_rules, never in enumeration,
      // per-rule matched/a_only/b_only, or the kappa population.
      windowKeys.add(key);
      continue;
    }

    if (av && bv) {
      // Matched key on both sides — verdict comparison, never an
      // enumeration miss regardless of label.
      const aLabel = labelOf(av.side);
      const bLabel = labelOf(bv.side);
      kappaCells.push({ rater_a: aLabel, rater_b: bLabel });
      ensureRule(ruleId).matched.push({ rater_a: aLabel, rater_b: bLabel });
      enumMatched++;
    } else if (av) {
      ensureRule(ruleId).a_only++;
      enumAOnly++;
    } else if (bv) {
      ensureRule(ruleId).b_only++;
      enumBOnly++;
    }
  }

  const per_rule: PerEventRuleMetrics[] = [...byRule.entries()]
    .map(([rule_id, r]) => {
      const nMatched = r.matched.length;
      const agree = r.matched.filter((c) => c.rater_a === c.rater_b).length;
      return {
        rule_id,
        n_matched: nMatched,
        verdict_agreement: nMatched > 0 ? agree / nMatched : 0,
        a_only: r.a_only,
        b_only: r.b_only,
      };
    })
    .sort((x, y) => (x.rule_id < y.rule_id ? -1 : x.rule_id > y.rule_id ? 1 : 0));

  const enumDenom = enumMatched + enumAOnly + enumBOnly;

  return {
    per_rule,
    verdict_kappa: cohensKappa(kappaCells),
    enumeration: {
      matched: enumMatched,
      a_only: enumAOnly,
      b_only: enumBOnly,
      jaccard: enumDenom > 0 ? enumMatched / enumDenom : 0,
    },
    window_rules: windowKeys.size,
  };
}
