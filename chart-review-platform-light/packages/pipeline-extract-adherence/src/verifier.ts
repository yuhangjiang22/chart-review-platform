// Verifier post-pass for adherence QuestionAnswers.
//
// After the extractor commits an answer via set_question_answer, we
// cross-check it against the patient's OMOP structured data and tag
// the answer with verifier_status + verifier_note. The status flips
// into:
//
//   "confirmed"     → structured data supports the answer
//   "contradicted"  → structured data clearly disagrees
//   "no_check"      → no structured signal available (defaults silently;
//                     this is the lookback-window / patient-new-to-system
//                     case the design's INSUFFICIENT_DATA attribution
//                     captures)
//
// Design alignment: this is the "Verifier subagent" from Section 3 of
// the ACCR design, simplified to a deterministic post-pass over the
// already-loaded structured data (no extra LLM call). Picks up the
// "documentation gap vs documented action" distinction that the
// lung-cancer study found accounted for 87.5% of non-concordance.
//
// Per-question check shape: pure function (answer, structured) →
// {status, note}. Each check reads only the table(s) it needs;
// unknown question_ids fall through to no_check. Add a new check by
// extending the CHECKS map below — no broader refactor needed.

import type { StructuredResponse } from "@chart-review/patients";
import type { QuestionAnswer } from "@chart-review/platform-types";

export interface VerifierVerdict {
  status: "confirmed" | "contradicted" | "no_check";
  note: string;
}

interface CheckCtx {
  answer: QuestionAnswer["answer"];
  structured: StructuredResponse;
}

type Check = (c: CheckCtx) => VerifierVerdict;

const NO_CHECK = (reason: string): VerifierVerdict => ({ status: "no_check", note: reason });
const CONFIRMED = (note: string): VerifierVerdict => ({ status: "confirmed", note });
const CONTRADICTED = (note: string): VerifierVerdict => ({ status: "contradicted", note });

// ─── per-question checks ──────────────────────────────────────────────

/** T0-AsthmaDx: conditions has any J45.* row with status=active. */
const checkAsthmaDx: Check = ({ answer, structured }) => {
  const conds = (structured.conditions ?? []) as Array<{ icd10cm?: string; status?: string }>;
  const hasAsthma = conds.some(
    (c) => typeof c.icd10cm === "string"
      && /^J45/i.test(c.icd10cm)
      && (c.status === "active" || c.status === undefined),
  );
  if (conds.length === 0) return NO_CHECK("conditions table empty");
  if (hasAsthma && answer === true) return CONFIRMED("conditions has an active J45.* row");
  if (!hasAsthma && answer === false) return CONFIRMED("no active J45.* row in conditions");
  if (hasAsthma && answer !== true) return CONTRADICTED("conditions has active J45.* but answer is not true");
  if (!hasAsthma && answer === true) return CONTRADICTED("answer says true but conditions has no active J45.*");
  return NO_CHECK("indeterminate against conditions");
};

/** T1-ControllerPrescribed: drugs has an active is_controller=true row. */
const checkControllerPrescribed: Check = ({ answer, structured }) => {
  const drugs = (structured.drugs ?? []) as Array<{
    is_controller?: boolean; active?: boolean; concept_name?: string;
  }>;
  if (drugs.length === 0) return NO_CHECK("drugs table empty");
  const ctrl = drugs.find((d) => d.is_controller === true && d.active !== false);
  if (ctrl && answer === true) return CONFIRMED(`drugs row matches controller: ${ctrl.concept_name ?? "?"}`);
  if (!ctrl && answer === false) return CONFIRMED("no active is_controller=true drug in drugs table");
  if (ctrl && answer !== true) return CONTRADICTED(`drugs has active controller (${ctrl.concept_name ?? "?"}) but answer is not true`);
  if (!ctrl && answer === true) return CONTRADICTED("answer says controller prescribed but drugs has none");
  return NO_CHECK("indeterminate against drugs");
};

/** T1-ACTScore: measurements has LOINC 75827-3 — pick most recent value. */
const checkACTScore: Check = ({ answer, structured }) => {
  const meas = (structured.measurements ?? []) as Array<{
    loinc?: string; value?: number; date?: string;
  }>;
  const acts = meas
    .filter((m) => m.loinc === "75827-3" && typeof m.value === "number")
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  if (acts.length === 0) return NO_CHECK("no LOINC 75827-3 (ACT) measurement");
  const latest = acts[0]!.value as number;
  if (typeof answer !== "number") {
    return CONTRADICTED(`measurements has ACT=${latest} (${acts[0]!.date}) but answer is non-numeric`);
  }
  if (Math.abs(answer - latest) <= 1) {
    return CONFIRMED(`measurements ACT=${latest} (${acts[0]!.date}) matches answer (±1)`);
  }
  return CONTRADICTED(`measurements ACT=${latest} (${acts[0]!.date}) ≠ answer ${answer}`);
};

/** T1-ExacerbationsCount: sum of asthma-related ED encounters + OCS bursts
 *  in the past 12 months from index_date. */
const checkExacerbationsCount: Check = ({ answer, structured }) => {
  const indexDate = structured.index_date;
  if (!indexDate) return NO_CHECK("no index_date on patient meta");
  const cutoff = new Date(indexDate);
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const encs = (structured.encounters ?? []) as Array<{
    type?: string; asthma_related?: boolean; start_date?: string;
  }>;
  const drugs = (structured.drugs ?? []) as Array<{
    drug_class?: string; days_supply?: number; start_date?: string;
    fills?: Array<{ fill_date?: string; days_supply?: number }>;
    indication?: string;
  }>;
  if (encs.length === 0 && drugs.length === 0) return NO_CHECK("encounters + drugs tables empty");

  const edAsthma = encs.filter(
    (e) =>
      (e.type === "Emergency" || e.type === "Inpatient")
      && e.asthma_related === true
      && (e.start_date ?? "") >= cutoffIso,
  ).length;
  const ocsBursts = drugs.flatMap((d) =>
    (d.fills ?? []).filter((f) =>
      d.drug_class === "OCS"
      && (f.days_supply ?? 0) <= 14
      && (f.fill_date ?? "") >= cutoffIso,
    ),
  ).length;
  const total = edAsthma + ocsBursts;

  if (typeof answer !== "number") {
    return CONTRADICTED(`structured count = ${total} (${edAsthma} ED + ${ocsBursts} OCS bursts) but answer non-numeric`);
  }
  if (answer === total) return CONFIRMED(`structured = ${total} (${edAsthma} ED + ${ocsBursts} OCS bursts)`);
  if (Math.abs(answer - total) <= 1) {
    return CONFIRMED(`structured = ${total}, answer = ${answer} (within ±1, accepted)`);
  }
  return CONTRADICTED(`structured = ${total} (${edAsthma} ED + ${ocsBursts} OCS) vs answer = ${answer}`);
};

/** T1-SABAOveruse: drugs has SABA row with saba_canisters_12mo >= 3
 *  OR ≥3 fills in the past 12 months. */
const checkSABAOveruse: Check = ({ answer, structured }) => {
  const drugs = (structured.drugs ?? []) as Array<{
    drug_class?: string; saba_canisters_12mo?: number;
    fills?: Array<{ fill_date?: string }>;
  }>;
  if (drugs.length === 0) return NO_CHECK("drugs table empty");
  const saba = drugs.find((d) => d.drug_class === "SABA");
  if (!saba) return NO_CHECK("no SABA row in drugs");
  let count: number;
  if (typeof saba.saba_canisters_12mo === "number") count = saba.saba_canisters_12mo;
  else {
    const indexDate = structured.index_date;
    if (!indexDate) return NO_CHECK("no SABA count + no index_date to count fills");
    const cutoff = new Date(indexDate);
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    count = (saba.fills ?? []).filter((f) => (f.fill_date ?? "") >= cutoffIso).length;
  }
  const overuse = count >= 3;
  if (answer === overuse) return CONFIRMED(`SABA fills/canisters = ${count} ${overuse ? "≥" : "<"} 3, answer matches`);
  if (answer === null) return NO_CHECK(`SABA count = ${count} but answer is null`);
  return CONTRADICTED(`SABA fills/canisters = ${count} (overuse=${overuse}) ≠ answer ${answer}`);
};

/** T1-SpirometryDate: most recent of procedures (CPT 94060/94010) and
 *  measurements (LOINC 19926-5 FEV1/FVC or 33452-4 FEV1%). */
const checkSpirometryDate: Check = ({ answer, structured }) => {
  const procs = (structured.procedures ?? []) as Array<{
    cpt?: string; procedure_date?: string;
  }>;
  const meas = (structured.measurements ?? []) as Array<{
    loinc?: string; date?: string;
  }>;
  const dates: string[] = [];
  for (const p of procs) if ((p.cpt === "94060" || p.cpt === "94010") && p.procedure_date) dates.push(p.procedure_date);
  for (const m of meas) if ((m.loinc === "19926-5" || m.loinc === "33452-4") && m.date) dates.push(m.date);
  if (dates.length === 0) return NO_CHECK("no spirometry procedures or measurements");
  const latest = dates.sort().reverse()[0]!;
  if (typeof answer !== "string") {
    return CONTRADICTED(`structured spirometry date = ${latest} but answer non-string`);
  }
  if (answer === latest) return CONFIRMED(`spirometry date matches: ${latest}`);
  return CONTRADICTED(`structured spirometry date = ${latest} ≠ answer ${answer}`);
};

/** T2-WrittenActionPlan: observations row with concept_name mentioning
 *  "action plan", value yes/no. */
const checkWrittenActionPlan: Check = ({ answer, structured }) => {
  const obs = (structured.observations ?? []) as Array<{
    concept_name?: string; value_as_string?: string; date?: string;
  }>;
  if (obs.length === 0) return NO_CHECK("observations table empty");
  const ap = obs
    .filter((o) => /action plan/i.test(o.concept_name ?? ""))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0];
  if (!ap) return NO_CHECK("no action-plan observation");
  const v = (ap.value_as_string ?? "").toLowerCase();
  const structuredBool = v === "yes" ? true : v === "no" ? false : null;
  if (structuredBool === null) return NO_CHECK(`action-plan observation value not yes/no: ${ap.value_as_string}`);
  if (answer === structuredBool) return CONFIRMED(`observations action-plan = ${v}, answer matches`);
  return CONTRADICTED(`observations action-plan = ${v} ≠ answer ${answer}`);
};

/** T2-FollowupScheduled: encounter with start_date strictly after
 *  index_date within ~3 months. */
const checkFollowupScheduled: Check = ({ answer, structured }) => {
  const indexDate = structured.index_date;
  if (!indexDate) return NO_CHECK("no index_date on patient meta");
  const encs = (structured.encounters ?? []) as Array<{ start_date?: string }>;
  if (encs.length === 0) return NO_CHECK("encounters table empty");
  const idx = new Date(indexDate);
  const horizon = new Date(idx); horizon.setMonth(horizon.getMonth() + 3);
  const horizonIso = horizon.toISOString().slice(0, 10);
  const future = encs.find((e) => (e.start_date ?? "") > indexDate && (e.start_date ?? "") <= horizonIso);
  if (future && answer === true) return CONFIRMED(`encounter on ${future.start_date} within 3mo`);
  if (!future && answer === false) return CONFIRMED("no encounter scheduled within 3mo of index");
  if (future && answer !== true) return CONTRADICTED(`encounter on ${future.start_date} but answer is not true`);
  if (!future && answer === true) return CONTRADICTED("answer true but no future encounter found");
  return NO_CHECK("indeterminate against encounters");
};

// Map of question_id → Check. Unknown question_ids resolve to no_check.
const CHECKS: Record<string, Check> = {
  "T0-AsthmaDx": checkAsthmaDx,
  "T1-ControllerPrescribed": checkControllerPrescribed,
  "T1-ACTScore": checkACTScore,
  "T1-ExacerbationsCount": checkExacerbationsCount,
  "T1-SABAOveruse": checkSABAOveruse,
  "T1-SpirometryDate": checkSpirometryDate,
  "T2-WrittenActionPlan": checkWrittenActionPlan,
  "T2-FollowupScheduled": checkFollowupScheduled,
};

/** Verify one QuestionAnswer against pre-loaded structured data.
 *  Pure — call sites can batch many answers per single structured-data
 *  load. Returns the verdict; doesn't mutate the answer. */
export function verifyAnswer(
  questionId: string,
  answer: QuestionAnswer["answer"],
  structured: StructuredResponse,
): VerifierVerdict {
  const check = CHECKS[questionId];
  if (!check) return NO_CHECK(`no structured check defined for ${questionId}`);
  try {
    return check({ answer, structured });
  } catch (e) {
    return NO_CHECK(`verifier error: ${(e as Error).message}`);
  }
}

/** Batch helper — apply verifier to every answer in a list and return
 *  a parallel array of verdicts. Loads structured data once. */
export function verifyAnswers(
  patientStructured: StructuredResponse,
  answers: QuestionAnswer[],
): VerifierVerdict[] {
  return answers.map((a) => verifyAnswer(a.question_id, a.answer, patientStructured));
}
