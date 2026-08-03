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

interface AdherenceStateView {
  validated_questions?: string[];
  validated_rules?: string[];
}

/**
 * Adherence completion spans both axes: every framework question AND every
 * framework rule must be validated for `reviewer_validated`. (An empty axis —
 * a framework with no rules, say — is treated as satisfied so it doesn't
 * block completion.) `in_progress` once any unit is validated but not all.
 */
export function deriveAdherenceReviewStatus(
  state: AdherenceStateView,
  framework: { questionIds: string[]; ruleIds: string[] },
): DerivedReviewStatus {
  const vq = new Set(state.validated_questions ?? []);
  const vr = new Set(state.validated_rules ?? []);
  const hasFramework = framework.questionIds.length > 0 || framework.ruleIds.length > 0;
  const questionsDone =
    framework.questionIds.length === 0 || framework.questionIds.every((q) => vq.has(q));
  const rulesDone =
    framework.ruleIds.length === 0 || framework.ruleIds.every((r) => vr.has(r));
  if (hasFramework && questionsDone && rulesDone) return "reviewer_validated";
  if (vq.size > 0 || vr.size > 0) return "in_progress";
  return undefined;
}
