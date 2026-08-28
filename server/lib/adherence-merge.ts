// Merge decisions shared by the two paths that fold new engine output into an
// existing adherence review_state: the event-save route (one rule recomputed
// after a reviewer edits an event) and /import (a whole new agent draft folded
// into whatever the reviewer has already done).
//
// Both have to answer the same two questions — what survives a recomputation,
// and what must stay consistent with what — so both answer them here.

import type {
  QuestionAnswer, RuleEvent, RuleRollup, RuleVerdict,
} from "@chart-review/platform-types";
import { evaluateAllRuleEvents, type RuleDefinition } from "@chart-review/rule-engine";

/** Fold a recomputation's rule verdicts into the stored ones.
 *
 *  A REVIEWER'S OWN VERDICT IS NEVER REPLACED BY A RECOMPUTATION.
 *
 *  Saving one event re-derives that rule — and every rule whose gate reads the
 *  derived worst control level — and this list was spliced wholesale, so a
 *  verdict the reviewer had explicitly overridden was silently replaced by the
 *  engine's. Three things then hid it: the row still read "✓ Accepted"
 *  (validated_rules is not touched), the readout is labelled "Engine:" so the
 *  substituted value looked like it belonged there, and the IAA route counts only
 *  `source === "reviewer"` verdicts — so the rule did not become a disagreement,
 *  it left the comparison altogether and shrank the denominator.
 *
 *  The reviewer's override is deliberate: they saw the engine's verdict and
 *  disagreed. The engine's fresh value is not lost either — it stays in that
 *  rule's rollup (`period_verdict`), which the pane renders beside the reviewer's
 *  as "engine now: X" when the two diverge. */
export function mergeRecomputedVerdicts(
  stored: RuleVerdict[], recomputed: RuleVerdict[], affected: Set<string>,
): RuleVerdict[] {
  const held = new Set(stored
    .filter((v) => v.source === "reviewer" && affected.has(v.rule_id))
    .map((v) => v.rule_id));
  return [
    ...stored.filter((v) => !affected.has(v.rule_id) || held.has(v.rule_id)),
    ...recomputed.filter((v) => !held.has(v.rule_id)),
  ];
}

/** The slice of a merged review_state this reconciliation reads and rewrites. */
export interface AdherenceMergedState {
  question_answers?: QuestionAnswer[];
  rule_verdicts?: RuleVerdict[];
  rule_events?: RuleEvent[];
  rule_rollups?: RuleRollup[];
  adherence_excluded?: boolean;
}

/** Make the answers, events, rollups and verdicts of a just-merged state
 *  describe the SAME data again.
 *
 *  `mergeAdherenceImport` folds four arrays that must agree with each other, and
 *  it folds them by three different rules — reviewer-wins-per-question_id,
 *  reviewer-wins-per-event_id, and keep-the-existing-rollup-for-any-rule-with-a-
 *  reviewer-event. Each rule is defensible alone; together they can leave the
 *  three arrays describing three different event sets. The clearest case: the
 *  reviewer edited one event of a rule, so that rule keeps its EXISTING rollup —
 *  computed over the OLD event list — while its events come from the new draft's
 *  work-list, which may enumerate a different number of them. The rollup then
 *  reports an n_events that no longer matches the events beside it, and the
 *  verdict (taken from the draft, which never saw the reviewer's answers) can
 *  disagree with both.
 *
 *  Rather than picking a winner between derived arrays, this re-derives them.
 *  Answers and events are the INPUTS a human authors; rollups and verdicts are
 *  OUTPUTS of the engine over those inputs, so the honest merge is to keep the
 *  merged inputs and recompute the outputs. Reviewer-authored inputs survive
 *  (that is the merge's job), reviewer VERDICT overrides survive
 *  (mergeRecomputedVerdicts), and everything else is consistent by construction.
 *
 *  Two deliberate skips:
 *  - `adherence_excluded` — the runner applies a blanket EXCLUDED to every rule
 *    when the eligibility gate fails, which is not something the per-rule engine
 *    pass reproduces. Recomputing would silently un-exclude the patient.
 *  - no `rule_events` — a legacy or period-only draft carries no event-level
 *    information, and the merge deliberately preserves whatever the state has. */
export function reconcileAdherenceImport(
  state: AdherenceMergedState, rules: RuleDefinition[],
): AdherenceMergedState {
  const events = state.rule_events ?? [];
  if (state.adherence_excluded || events.length === 0) return state;

  const answers = state.question_answers ?? [];
  const res = evaluateAllRuleEvents(rules, answers, events);

  // source/ts are the reviewer's provenance, not engine output — carrying them
  // over is what keeps reviewer-win working on the NEXT import.
  const byId = new Map(res.rule_events.map((e) => [e.event_id, e]));
  const reconciledEvents = events.map((e) => {
    const fresh = byId.get(e.event_id);
    return fresh ? { ...fresh, source: e.source, ts: e.ts } : e;
  });

  const derivedIds = new Set(res.derived_answers.map((a) => a.question_id));
  return {
    ...state,
    question_answers: [
      ...answers.filter((a) => !derivedIds.has(a.question_id)),
      ...res.derived_answers,
    ],
    rule_events: reconciledEvents,
    rule_rollups: res.rule_rollups,
    rule_verdicts: mergeRecomputedVerdicts(
      state.rule_verdicts ?? [], res.rule_verdicts,
      new Set(res.rule_verdicts.map((v) => v.rule_id)),
    ),
  };
}
