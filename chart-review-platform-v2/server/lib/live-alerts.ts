import { fieldApplicability, evalDerivation, type MinimalTask } from "./contract-eval.js";
import type { CrossCriterionAlert } from "./types.js";

interface MinAssessment {
  field_id: string;
  answer?: unknown;
  status?: string;
}

interface MinState {
  field_assessments?: MinAssessment[];
}

export function recomputeLiveAlerts(task: MinimalTask, state: MinState): CrossCriterionAlert[] {
  const answers: Record<string, unknown> = {};
  for (const fa of state.field_assessments ?? []) {
    if (fa.answer !== undefined) answers[fa.field_id] = fa.answer;
  }
  const now = new Date().toISOString();
  const out: CrossCriterionAlert[] = [];

  // answer_consistency alerts are reserved for future expansion. Current rules
  // only emit applicability_violation + derivation_violation; both cover the
  // most common is_applicable_when / derivation contradictions.
  for (const f of task.fields) {
    // applicability_violation: field has an answer but its gate evaluates to not_applicable
    if (f.is_applicable_when && answers[f.id] !== undefined) {
      const app = fieldApplicability(task, answers, f.id);
      if (app === "not_applicable") {
        out.push({
          id: `app:${f.id}`,
          kind: "applicability_violation",
          fields: [f.id],
          severity: "warning",
          message: `${f.id} has an answer but its is_applicable_when gate evaluates to not_applicable.`,
          computed_at: now,
        });
      }
    }
    // derivation_violation: derived field returns null (missing or inconsistent inputs)
    if (f.derivation) {
      const v = evalDerivation(task, answers, f.id);
      if (v === null) {
        out.push({
          id: `der:${f.id}`,
          kind: "derivation_violation",
          fields: [f.id],
          severity: "warning",
          message: `${f.id} derivation could not be evaluated (missing or inconsistent inputs).`,
          computed_at: now,
        });
      }
    }
  }
  return out;
}
