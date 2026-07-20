// PSMA PET/CT context summary — a DERIVED artifact rendered deterministically
// from the answered chart-review questions. It asserts nothing the questions
// don't answer (grounding is structural: a clause is emitted only for a present,
// non-"unclear" answer), and it covers the must-include set by construction.
// See docs/superpowers/plans/2026-07-16-psma-context-adherence-task.md ("Plan 2")
// and RUBRIC_DRAFT.md ("Summary").

import type { QuestionAnswer } from "@chart-review/platform-types";

const INDICATION: Record<string, string> = {
  initial_staging: "initial staging",
  biochemical_recurrence: "biochemical recurrence",
  restaging: "restaging",
  treatment_response: "treatment response",
};

const METS: Record<string, string> = {
  none: "No prior metastatic disease.",
  nodal: "Prior nodal metastatic disease.",
  osseous: "Prior osseous metastatic disease.",
  visceral: "Prior visceral metastatic disease.",
  multiple: "Prior multifocal metastatic disease.",
};

export interface ContextSummary {
  /** The rendered 3–5 sentence context blurb. */
  summary: string;
  /** The question_ids whose answers contributed — full provenance for each clause. */
  used_questions: string[];
}

/**
 * Render the PSMA context summary from a flat list of answered questions.
 * Deduplicates by question_id (last write wins — callers that carry both agent
 * and reviewer answers should pass the preferred one last).
 */
export function renderPsmaContextSummary(answers: QuestionAnswer[]): ContextSummary {
  const by = new Map<string, QuestionAnswer["answer"]>();
  for (const a of answers) by.set(a.question_id, a.answer);

  const used: string[] = [];
  // A "present" answer is non-null, non-empty, and not the explicit "unclear".
  const val = (id: string): string | undefined => {
    const v = by.get(id);
    if (v === undefined || v === null || v === "" || v === "unclear") return undefined;
    return String(v);
  };

  const sentences: string[] = [];

  // 1. Disease + surgery.
  let s1 = "Prostate adenocarcinoma";
  const gg = val("PC1a");
  if (gg) {
    used.push("PC1a");
    s1 += ` (Grade Group ${gg.replace(/^GG/, "")})`;
  }
  if (val("PC2a") === "yes") {
    used.push("PC2a");
    s1 += ", s/p radical prostatectomy";
  }
  sentences.push(s1 + ".");

  // 2. Exam + PSA.
  const ind = val("PC3a");
  if (ind && INDICATION[ind]) {
    used.push("PC3a");
    let s2 = `PSMA PET/CT for ${INDICATION[ind]}`;
    const psa = val("PC1c");
    if (psa !== undefined) {
      used.push("PC1c");
      let psaStr = `PSA ${psa}`;
      const trend = val("PC1d");
      if (trend && ["rising", "falling", "stable"].includes(trend)) {
        used.push("PC1d");
        psaStr += `, ${trend}`;
      }
      s2 += ` (${psaStr})`;
    }
    sentences.push(s2 + ".");
  }

  // 3. ADT status (report only the states worth flagging for interpretation).
  const adt = val("PC2c");
  if (adt === "active") {
    used.push("PC2c");
    sentences.push("On active ADT.");
  } else if (adt === "completed") {
    used.push("PC2c");
    sentences.push("Prior ADT.");
  }

  // 4. Prior metastatic disease.
  const mets = val("PC1e");
  if (mets && METS[mets]) {
    used.push("PC1e");
    sentences.push(METS[mets]);
  }

  return { summary: sentences.join(" "), used_questions: used };
}
