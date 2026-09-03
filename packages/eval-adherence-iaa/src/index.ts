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
// 2026-08-24, Task 7; statistically hardened in the Task 7 quality
// review — see the C1-C4 fixes below). Pairs two annotation sides'
// RuleEvent[] — flattened to EventSide[] by the caller — by
// `${patient_id}|${event_id}`. The CALLER is responsible for C1: side A
// must be the agent's PRISTINE shadow draft (`agent_rule_events[agent_id]`),
// never `rule_events` once a human has validated in place, or every
// already-validated event scores as human-vs-self guaranteed agreement.
// This function has no way to detect that mistake — it only sees flattened
// EventSide[] — so the CLI is where C1 is actually enforced.
//
// Two axes, reported separately (plan ERRATA, Task 6 re-review):
//
//   1. Enumeration — did both sides produce the same anchored events at
//      all? Window-rule stubs (anchor.type === "window", no date) are
//      constants present on both sides by construction and are never
//      rendered as comparable timeline cards, so they are excluded from
//      matched/a_only/b_only/jaccard and reported separately as
//      `window_rules`. (C4) Stratified further by `anchor.origin`: both
//      sides are seeded from the SAME deterministic work-list whenever the
//      provenance gate passes, so the omop-origin stratum's agreement is
//      close to tautological by construction — the note-origin stratum
//      (annotator-supplemented events) is the real signal, reported
//      separately under `enumeration.by_origin`.
//   2. Verdict agreement — for matched keys where BOTH sides have
//      progressed past "unscored", do the two sides' verdict labels
//      agree? (C2) A present-but-unscored event (no verdict yet — a
//      seeded stub neither annotator has reached) is label "NONE"; a
//      NONE/NONE pair is EXCLUDED from `verdict_kappa`/`verdict_agreement`
//      /each rule's `verdict_agreement` — counting it as agreement lets an
//      incomplete annotation pass score BETTER than a complete one. It is
//      still counted (via `n_unscored_a`/`n_unscored_b`/`n_unscored_both`
//      and the `completeness_a`/`completeness_b` fractions) so the gap is
//      visible rather than silently dropped. An event the agent explicitly
//      judged NOT_EVALUABLE is a real judgment, not an absence — it stays
//      distinct from "NONE" and DOES enter the scored population against a
//      counterpart that carries an actual verdict.
//
// (Important 5, Task 7 re-review) The SAME exclusion applies when only ONE
// side is "NONE" — not just the NONE/NONE both-unscored case above. If side
// A already committed a real verdict for a matched-anchored event but side
// B (the gold) hasn't reached it yet, that pair is excluded from
// `verdict_n`/`verdict_agreement` entirely — it is not counted as a
// disagreement even though a real, uncontradicted verdict exists on one
// side. This is UNDOCUMENTED-BY-DESIGN behavior, not a bug: scoring a
// one-sided verdict as a disagreement would penalize incompleteness twice
// (once via the completeness fractions, once via a manufactured
// disagreement against a stub). But it has the identical externally-visible
// failure mode the both-unscored fix above was raised to kill: measured,
// dropping ONE gold verdict out of three moved verdict_agreement from
// 33.3% (n=3) to 50.0% (n=2) — the incomplete pass reads BETTER than the
// complete one. The CLI's completeness gate (scripts/asthma-annotate/
// iaa-events.ts) is the ONLY thing standing between this function and that
// outcome reaching a report: it refuses to print the headline kappa/
// agreement whenever completeness_a or completeness_b < 1, and
// `--allow-incomplete` is what releases it. Anyone calling this function
// directly (bypassing the CLI) gets no such protection.
//
// (C3) `cohensKappa` returns 1 for a no-variance population (a documented
// convention of the shared helper, harmless where it's already used) but
// that reads as "perfect agreement" for what is really "nothing to
// chance-correct" — misleading when asthma golds skew heavily CONCORDANT.
// This surface does NOT delegate that convention: `verdict_kappa` is NaN
// (with `verdict_kappa_reason` explaining why) whenever fewer than 2
// matched-scored pairs exist OR fewer than 2 distinct labels are observed
// among them. `verdict_n`, `verdict_agreement` (raw fraction), and the
// `label_marginals`/`confusion` breakdown are always reported alongside so
// a masked kappa is never silently indistinguishable from "no data".

/** One side's view of one event, flattened for comparison. */
export interface EventSide {
  patient_id: string;
  event_id: string;
  rule_id: string;
  /** anchor.type !== "window" && anchor.date — window stubs are constants on
   *  both sides and are reported separately, never inside the enumeration
   *  counts (plan ERRATA, Task 6 re-review). */
  anchored: boolean;
  /** anchor.origin — "omop" (ETL-seeded, deterministic work-list) vs "note"
   *  (annotator-supplemented). Required: the enumeration axis is
   *  stratified by this (C4) because the omop stratum's agreement is
   *  driven mostly by the shared deterministic seed, not independent
   *  annotation — the note stratum is where real signal lives. */
  origin: "omop" | "note";
  verdict?: "CONCORDANT" | "NON_CONCORDANT" | "EXCLUDED";
  evaluable?: boolean;
}

export interface PerEventRuleMetrics {
  rule_id: string;
  /** Anchored keys present on both sides, regardless of verdict/score. */
  n_matched: number;
  /** Subset of n_matched where BOTH sides carry a real label (non-"NONE") —
   *  the population verdict_agreement is computed over (C2). */
  n_scored: number;
  /** NaN when n_scored === 0 (nothing to score, not "0% agreement"). */
  verdict_agreement: number;
  a_only: number;
  b_only: number;
  /** Scored pairs (both sides non-"NONE") whose labels differ. Mirrors
   *  PerRuleMetrics.disagreements[] from the sibling per-rule surface. */
  disagreements: Array<{ patient_id: string; event_id: string; a: string; b: string }>;
}

interface OriginBucket { matched: number; a_only: number; b_only: number; jaccard: number }

export interface PerEventReport {
  per_rule: PerEventRuleMetrics[];
  /** NaN when not computable — see verdict_kappa_reason. Never silently
   *  coerced to 1 for a no-variance population (C3) or to 0 for no data. */
  verdict_kappa: number;
  /** Present iff verdict_kappa is NaN, so a consumer can't mistake NaN
   *  (which JSON serializes to null) for "no data" vs "no variance" vs one
   *  rater being degenerate (Critical 2, Task 7 re-review). */
  verdict_kappa_reason?: "insufficient_pairs" | "no_label_variance" | "constant_rater_a" | "constant_rater_b";
  /** Matched-anchored pairs where BOTH sides are scored — the population
   *  feeding verdict_kappa and verdict_agreement. */
  verdict_n: number;
  /** Raw fraction of verdict_n pairs where labels agree. NaN when
   *  verdict_n === 0. Distinct from verdict_kappa (chance-corrected).
   *  KNOWN GAP (Task 7 re-review #2): this field, completeness_a/b, and
   *  enumeration.jaccard (+ its by_origin copies) can all be NaN with no
   *  accompanying "_reason" field — only verdict_kappa carries one. A
   *  consumer has to infer which of "no data" / "n=0 denominator" applies
   *  from context (verdict_n, enumeration.matched, etc.) rather than
   *  reading it off a dedicated field the way verdict_kappa_reason lets it. */
  verdict_agreement: number;
  /** Observed label counts over the verdict_n population — surfaces
   *  prevalence skew that can make a low kappa look like a bug when it
   *  isn't (C3). */
  label_marginals: { a: Record<string, number>; b: Record<string, number> };
  /** Full confusion matrix over the verdict_n population, sparse
   *  (a, b, n) triples. */
  confusion: Array<{ a: string; b: string; n: number }>;
  /** Matched-anchored pairs where side A's label is "NONE" (regardless of
   *  B) / side B's label is "NONE" / both are "NONE" (C2). */
  n_unscored_a: number;
  n_unscored_b: number;
  n_unscored_both: number;
  /** Fraction of matched-anchored events where that side is scored
   *  (non-"NONE"). NaN when there are no matched-anchored events at all. */
  completeness_a: number;
  completeness_b: number;
  enumeration: {
    matched: number;
    a_only: number;
    b_only: number;
    /** NaN when matched+a_only+b_only === 0 (no data — was incorrectly 0,
     *  read as "total disagreement"; a real 0 still reports as 0). */
    jaccard: number;
    /** (C4) Same shape, stratified by anchor.origin. omop is close to
     *  tautological by construction (see file header); note is the real
     *  signal. */
    by_origin: { omop: OriginBucket; note: OriginBucket };
  };
  /** Distinct non-anchored (window-scoped) keys seen — a deduplicated
   *  union across both sides, NOT a max. Reported, never scored. */
  window_rules: number;
}

interface EventKeyed {
  key: string;
  rule_id: string;
  anchored: boolean;
  origin: "omop" | "note";
  side: EventSide;
}

function keyOf(e: EventSide): string {
  return `${e.patient_id}|${e.event_id}`;
}

function labelOf(e: EventSide): string {
  return e.evaluable === false ? "NOT_EVALUABLE" : e.verdict ?? "NONE";
}

function isScored(label: string): boolean {
  return label !== "NONE";
}

/** Indexes one side's events by key, throwing on a duplicate event_id
 *  within that side (C9 / duplicate-detection) — silently taking the last
 *  one would make the result depend on array order. */
function indexEvents(events: EventSide[], side: "a" | "b"): Map<string, EventKeyed> {
  const idx = new Map<string, EventKeyed>();
  for (const e of events) {
    const key = keyOf(e);
    if (idx.has(key)) {
      throw new Error(
        `computePerEventMetrics: duplicate event_id within side ${side}: ` +
        `patient_id=${e.patient_id} event_id=${e.event_id}`,
      );
    }
    idx.set(key, { key, rule_id: e.rule_id, anchored: e.anchored, origin: e.origin, side: e });
  }
  return idx;
}

/** cohensKappa returns 1 for <2 pairs or <2 distinct labels — a documented
 *  convention that's misleading for this surface (C3, see file header).
 *  Returns NaN with a reason instead of delegating to that convention.
 *
 *  (Critical 2, Task 7 re-review) The union-of-both-raters check above only
 *  catches the case where every pair shares the SAME single label across
 *  BOTH sides at once (e.g. every pair is CONCORDANT/CONCORDANT). It does
 *  NOT catch the more common real-world regime: only ONE rater's marginal
 *  is constant while the other varies — a CONCORDANT-heavy blind gold that
 *  never once used NON_CONCORDANT, paired against an agent whose verdicts
 *  do vary. Whenever one rater's marginal has a single value, pExp for that
 *  label collapses to exactly the same value as pObs (P(both=label) =
 *  P(other rater=label) since the constant rater contributes probability 1
 *  to every one of those pairs), forcing kappa to identically 0 —
 *  regardless of whether the other rater agreed 99% of the time or 1% of
 *  the time. Measured: a constant-CONCORDANT gold against a varying agent
 *  returns kappa=0.0000 at 50%, 90%, 10%, AND 99% raw agreement. Asthma
 *  golds are CONCORDANT-heavy, so this is the expected regime, and
 *  "kappa=0.000" in a Methods section reads as "no better than chance" when
 *  the true problem is just that the math is undefined here. Check each
 *  rater's own marginal independently and refuse with a dedicated reason
 *  before that math ever runs. */
function eventKappa(cells: KappaCell[]): {
  kappa: number;
  reason?: "insufficient_pairs" | "no_label_variance" | "constant_rater_a" | "constant_rater_b";
} {
  if (cells.length < 2) return { kappa: Number.NaN, reason: "insufficient_pairs" };
  const labels = new Set<string>();
  for (const c of cells) { labels.add(c.rater_a); labels.add(c.rater_b); }
  if (labels.size < 2) return { kappa: Number.NaN, reason: "no_label_variance" };
  const aLabels = new Set(cells.map((c) => c.rater_a));
  if (aLabels.size < 2) return { kappa: Number.NaN, reason: "constant_rater_a" };
  const bLabels = new Set(cells.map((c) => c.rater_b));
  if (bLabels.size < 2) return { kappa: Number.NaN, reason: "constant_rater_b" };
  return { kappa: cohensKappa(cells) };
}

function marginalsAndConfusion(cells: KappaCell[]): Pick<PerEventReport, "label_marginals" | "confusion"> {
  const a: Record<string, number> = {};
  const b: Record<string, number> = {};
  const confCounts = new Map<string, number>();
  for (const c of cells) {
    a[c.rater_a] = (a[c.rater_a] ?? 0) + 1;
    b[c.rater_b] = (b[c.rater_b] ?? 0) + 1;
    const k = JSON.stringify([c.rater_a, c.rater_b]);
    confCounts.set(k, (confCounts.get(k) ?? 0) + 1);
  }
  const confusion = [...confCounts.entries()]
    .map(([k, n]) => {
      const [ca, cb] = JSON.parse(k) as [string, string];
      return { a: ca!, b: cb!, n };
    })
    .sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : x.b > y.b ? 1 : 0) : x.a < y.a ? -1 : 1));
  return { label_marginals: { a, b }, confusion };
}

function jaccardOf(matched: number, aOnly: number, bOnly: number): number {
  const denom = matched + aOnly + bOnly;
  return denom > 0 ? matched / denom : Number.NaN;
}

/**
 * Per-event inter-annotator agreement. Pairs two flattened event lists by
 * `${patient_id}|${event_id}` and reports enumeration + verdict-agreement
 * axes separately, both scoped to ANCHORED events (window stubs only bump
 * `window_rules`). `per_rule` lists every rule_id seen on either side (a
 * pure-window rule gets a zeroed row, not an absent one). Throws on a
 * duplicate event_id within one side, or when a matched key's two sides
 * disagree on `anchored`/`rule_id` (a data-integrity bug upstream, not
 * something to silently resolve A-wins). Pure / deterministic / no I/O —
 * same shape as computePerRuleMetrics above.
 */
export function computePerEventMetrics(a: EventSide[], b: EventSide[]): PerEventReport {
  const aIdx = indexEvents(a, "a");
  const bIdx = indexEvents(b, "b");
  const allKeys = new Set([...aIdx.keys(), ...bIdx.keys()]);

  let enumMatched = 0, enumAOnly = 0, enumBOnly = 0;
  const byOrigin: Record<"omop" | "note", { matched: number; a_only: number; b_only: number }> = {
    omop: { matched: 0, a_only: 0, b_only: 0 },
    note: { matched: 0, a_only: 0, b_only: 0 },
  };
  const windowKeys = new Set<string>();
  const kappaCells: KappaCell[] = [];
  let nUnscoredA = 0, nUnscoredB = 0, nUnscoredBoth = 0;

  interface RuleAcc {
    n_matched: number;
    scoredCells: KappaCell[];
    a_only: number;
    b_only: number;
    disagreements: PerEventRuleMetrics["disagreements"];
  }
  const byRule = new Map<string, RuleAcc>();
  const ensureRule = (rid: string): RuleAcc => {
    let r = byRule.get(rid);
    if (!r) { r = { n_matched: 0, scoredCells: [], a_only: 0, b_only: 0, disagreements: [] }; byRule.set(rid, r); }
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

    if (av && bv) {
      if (av.anchored !== bv.anchored) {
        throw new Error(
          `computePerEventMetrics: key ${key} disagrees on anchored (a=${av.anchored}, b=${bv.anchored})`,
        );
      }
      if (av.rule_id !== bv.rule_id) {
        throw new Error(
          `computePerEventMetrics: key ${key} disagrees on rule_id (a=${av.rule_id}, b=${bv.rule_id})`,
        );
      }
      // (Important 3, Task 7 re-review) origin used to fall through to the
      // `(av?.origin ?? bv?.origin)!` silent-A-wins line below, miscategorizing
      // any disagreement into whichever origin side A happened to carry — the
      // tautological omop stratum, most of the time. anchored and rule_id
      // already throw on the same kind of disagreement; origin gets the same
      // treatment instead of being silently resolved.
      if (av.origin !== bv.origin) {
        throw new Error(
          `computePerEventMetrics: key ${key} disagrees on origin (a=${av.origin}, b=${bv.origin})`,
        );
      }
    }

    const ruleId = (av?.rule_id ?? bv?.rule_id)!;
    const anchored = (av?.anchored ?? bv?.anchored) === true;
    const origin = (av?.origin ?? bv?.origin)!;

    if (!anchored) {
      // Window stub: counted only in window_rules, never in enumeration,
      // per-rule counters, or the kappa population.
      windowKeys.add(key);
      continue;
    }

    if (av && bv) {
      enumMatched++;
      byOrigin[origin].matched++;
      const r = ensureRule(ruleId);
      r.n_matched++;

      const aLabel = labelOf(av.side);
      const bLabel = labelOf(bv.side);
      const aScored = isScored(aLabel);
      const bScored = isScored(bLabel);
      if (!aScored) nUnscoredA++;
      if (!bScored) nUnscoredB++;
      if (!aScored && !bScored) nUnscoredBoth++;

      if (aScored && bScored) {
        // (C2) Only pairs where BOTH sides have progressed past "NONE"
        // enter the verdict-agreement population.
        kappaCells.push({ rater_a: aLabel, rater_b: bLabel });
        r.scoredCells.push({ rater_a: aLabel, rater_b: bLabel });
        if (aLabel !== bLabel) {
          r.disagreements.push({ patient_id: av.side.patient_id, event_id: av.side.event_id, a: aLabel, b: bLabel });
        }
      }
    } else if (av) {
      ensureRule(ruleId).a_only++;
      enumAOnly++;
      byOrigin[origin].a_only++;
    } else if (bv) {
      ensureRule(ruleId).b_only++;
      enumBOnly++;
      byOrigin[origin].b_only++;
    }
  }

  const per_rule: PerEventRuleMetrics[] = [...byRule.entries()]
    .map(([rule_id, r]) => {
      const nScored = r.scoredCells.length;
      const agree = r.scoredCells.filter((c) => c.rater_a === c.rater_b).length;
      return {
        rule_id,
        n_matched: r.n_matched,
        n_scored: nScored,
        verdict_agreement: nScored > 0 ? agree / nScored : Number.NaN,
        a_only: r.a_only,
        b_only: r.b_only,
        disagreements: r.disagreements,
      };
    })
    .sort((x, y) => (x.rule_id < y.rule_id ? -1 : x.rule_id > y.rule_id ? 1 : 0));

  const { kappa: verdict_kappa, reason: verdict_kappa_reason } = eventKappa(kappaCells);
  const verdict_n = kappaCells.length;
  const scoredAgree = kappaCells.filter((c) => c.rater_a === c.rater_b).length;
  const verdict_agreement = verdict_n > 0 ? scoredAgree / verdict_n : Number.NaN;
  const { label_marginals, confusion } = marginalsAndConfusion(kappaCells);

  const completeness_a = enumMatched > 0 ? (enumMatched - nUnscoredA) / enumMatched : Number.NaN;
  const completeness_b = enumMatched > 0 ? (enumMatched - nUnscoredB) / enumMatched : Number.NaN;

  return {
    per_rule,
    verdict_kappa,
    ...(verdict_kappa_reason ? { verdict_kappa_reason } : {}),
    verdict_n,
    verdict_agreement,
    label_marginals,
    confusion,
    n_unscored_a: nUnscoredA,
    n_unscored_b: nUnscoredB,
    n_unscored_both: nUnscoredBoth,
    completeness_a,
    completeness_b,
    enumeration: {
      matched: enumMatched,
      a_only: enumAOnly,
      b_only: enumBOnly,
      jaccard: jaccardOf(enumMatched, enumAOnly, enumBOnly),
      by_origin: {
        omop: { ...byOrigin.omop, jaccard: jaccardOf(byOrigin.omop.matched, byOrigin.omop.a_only, byOrigin.omop.b_only) },
        note: { ...byOrigin.note, jaccard: jaccardOf(byOrigin.note.matched, byOrigin.note.a_only, byOrigin.note.b_only) },
      },
    },
    window_rules: windowKeys.size,
  };
}
