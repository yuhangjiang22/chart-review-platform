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
 * Without the events axis, a blind gold-collection session (which answers
 * ONLY events, never touching validated_questions/validated_rules) could
 * never reach reviewer_validated — which also means the anti-clobber
 * "never re-import over an already-validated patient" guard (App.tsx)
 * would never engage for it.
 */
export function deriveAdherenceReviewStatus(
  state: AdherenceStateView,
  framework: { questionIds: string[]; ruleIds: string[] },
): DerivedReviewStatus {
  const vq = new Set(state.validated_questions ?? []);
  const vr = new Set(state.validated_rules ?? []);
  const ve = new Set(state.validated_events ?? []);
  const anchoredEventIds = (state.rule_events ?? [])
    .filter(isAnchoredEvent)
    .map((e) => e.event_id);
  const hasFramework =
    framework.questionIds.length > 0 || framework.ruleIds.length > 0 || anchoredEventIds.length > 0;
  const questionsDone =
    framework.questionIds.length === 0 || framework.questionIds.every((q) => vq.has(q));
  const rulesDone =
    framework.ruleIds.length === 0 || framework.ruleIds.every((r) => vr.has(r));
  const eventsDone =
    anchoredEventIds.length === 0 || anchoredEventIds.every((id) => ve.has(id));
  if (hasFramework && questionsDone && rulesDone && eventsDone) return "reviewer_validated";
  if (vq.size > 0 || vr.size > 0 || ve.size > 0) return "in_progress";
  return undefined;
}
