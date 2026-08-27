// review-completion — derive a review_state's `review_status` from the
// reviewer's per-unit validation progress, per task kind.
//
// WHY THIS EXISTS: phenotype maintains `review_status` via its gated
// /validate finalize (review-routes.ts), so every "outside" view
// (SessionSidebar `oracle_done`, GET /api/patients, performance, export
// gold) — all of which key on `review_status === "reviewer_validated"` —
// lights up. NER and adherence had per-unit validation
// (validated_notes / validated_questions / validated_rules) but NO code
// path ever flipped `review_status`, so their patients stayed
// `agent_drafted` forever and never showed as validated anywhere outside
// the review pane, and never entered performance. These derivations close
// that gap: the per-unit validation routes call them after each write.
//
// Contract: returns the status the reviewer's progress implies, or
// `undefined` to mean "no reviewer progress — leave the status as-is".
// Callers MUST NOT apply the result when the record is "locked".

export type DerivedReviewStatus = "reviewer_validated" | "in_progress" | undefined;

interface NerStateView {
  span_labels?: Array<{ note_id: string }>;
  validated_notes?: string[];
}

/**
 * NER completion is note-level: the reviewer validates each note that has
 * spans (the unit SpanReview exposes). The patient is `reviewer_validated`
 * once every note that carries spans is in `validated_notes`; `in_progress`
 * once at least one is validated but not all. A patient with zero spans has
 * nothing to validate → `undefined` (leave as drafted).
 */
export function deriveNerReviewStatus(state: NerStateView): DerivedReviewStatus {
  const noteSet = new Set((state.span_labels ?? []).map((s) => s.note_id));
  const validated = new Set(state.validated_notes ?? []);
  if (noteSet.size > 0 && [...noteSet].every((n) => validated.has(n))) {
    return "reviewer_validated";
  }
  if (validated.size > 0) return "in_progress";
  return undefined;
}

interface AdherenceStateViewRuleEvent {
  event_id: string;
  anchor: { type: string; date?: string };
}

interface AdherenceStateView {
  validated_questions?: string[];
  validated_rules?: string[];
  /** Event-concordance design (spec 2026-08-24): the full seeded work-list
   *  and the reviewer's per-event validation progress. Both optional so
   *  legacy period-only states (no rule_events at all) are unaffected. */
  rule_events?: AdherenceStateViewRuleEvent[];
  validated_events?: string[];
}

/** Mirrors EventTimeline.isAnchoredEvent (client) — an event needs a valid
 *  date to be a reviewable unit; window-rule events aren't individually
 *  validated (they're covered by validated_rules instead). Kept in sync
 *  deliberately: both sides decide "what counts as an anchored event" the
 *  same way, or completion and the UI's own event count would disagree. */
function isAnchoredEvent(e: AdherenceStateViewRuleEvent): boolean {
  return e.anchor.type !== "window" && !!e.anchor.date;
}

/**
 * Adherence completion spans three axes: every framework question, every
 * framework rule, AND (when the state carries anchored rule_events — the
 * event-concordance design) every anchored event must be validated for
 * `reviewer_validated`. (An empty axis — a framework with no rules, or a
 * state with no anchored events, say — is treated as satisfied so it
 * doesn't block completion.) `in_progress` once any unit on any axis is
 * validated but not all.
 *
 * EVENTS-ONLY COMPLETION PATH (Task 5 re-review, Important 2): the
 * three-axis rule above is unreachable for a real framework by a BLIND
 * gold-collection session, which answers ONLY events and never calls the
 * question-answer / rule-verdict routes — so `validated_questions` /
 * `validated_rules` stay permanently empty while `framework.questionIds` /
 * `ruleIds` (built from the real skill at every call site) are non-empty.
 * `questionsDone`/`rulesDone` would never be satisfiable, so the patient
 * would sit at `in_progress` forever and the anti-clobber "never re-import
 * over an already-validated patient" guard (App.tsx) would never engage.
 *
 * Fix: `validated_questions` and `validated_rules` BOTH being empty is used
 * as the signal for "this is the blind-gold shape" (there is no session
 * context available to this pure function — it only sees `state` +
 * `framework`). When that shape holds AND every anchored event is
 * validated, completion is satisfied on the events axis alone,
 * independent of framework.questionIds/ruleIds. This does NOT weaken the
 * normal (non-blind) path below it: a session that has validated ANY
 * question or rule falls through to the original three-axis check, which
 * NOW also requires eventsDone (tightened by the events axis added above) —
 * so a non-blind session with all questions+rules validated but one
 * anchored event still unvalidated stays `in_progress`, not
 * `reviewer_validated` (pinned by a regression test).
 *
 * Known accepted edge case: nothing here distinguishes "a genuinely blind
 * session" from "a non-blind reviewer who validated every event before
 * ever touching the Question framework / Rule verdicts panels" — both
 * produce the same (empty vq, empty vr, full ve) shape and both complete
 * via this path. The question-framework panel isn't required by the UI
 * before saving event answers, so this is a real possibility, not just a
 * theoretical one; it was judged an acceptable tradeoff since the
 * alternative (threading `session.blind` into this pure derivation) adds
 * a dependency this function doesn't otherwise have.
 */
export function deriveAdherenceReviewStatus(
  state: AdherenceStateView,
  framework: {
    questionIds: string[];
    ruleIds: string[];
    /** question_ids answered PER EVENT rather than for the period. EXCLUDED
     *  from the question check entirely: they have no period-level answer to
     *  validate (the MCP write path refuses one), their work is the per-event
     *  annotation, and `eventsDone` already covers that. Counting them here as
     *  well would gate completion twice on the same work. */
    eventScopedQuestionIds?: string[];
  },
): DerivedReviewStatus {
  const vq = new Set(state.validated_questions ?? []);
  const vr = new Set(state.validated_rules ?? []);
  const ve = new Set(state.validated_events ?? []);
  const anchoredEventIds = (state.rule_events ?? [])
    .filter(isAnchoredEvent)
    .map((e) => e.event_id);
  const eventsDone =
    anchoredEventIds.length === 0 || anchoredEventIds.every((id) => ve.has(id));

  // Blind-gold shape: only events are being tracked at all. Complete as
  // soon as every anchored event is validated, regardless of what the
  // real framework's questionIds/ruleIds are.
  if (vq.size === 0 && vr.size === 0 && anchoredEventIds.length > 0 && eventsDone) {
    return "reviewer_validated";
  }

  const hasFramework =
    framework.questionIds.length > 0 || framework.ruleIds.length > 0 || anchoredEventIds.length > 0;
  const eventScoped = new Set(framework.eventScopedQuestionIds ?? []);
  const periodQuestionIds = framework.questionIds.filter((q) => !eventScoped.has(q));
  const questionsDone =
    periodQuestionIds.length === 0 || periodQuestionIds.every((q) => vq.has(q));
  const rulesDone =
    framework.ruleIds.length === 0 || framework.ruleIds.every((r) => vr.has(r));
  if (hasFramework && questionsDone && rulesDone && eventsDone) return "reviewer_validated";
  if (vq.size > 0 || vr.size > 0 || ve.size > 0) return "in_progress";
  return undefined;
}
