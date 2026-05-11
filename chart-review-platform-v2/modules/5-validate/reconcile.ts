// Reconcile module — thin wrapper around v1's compareDrafts.
//
// v1's `disagreements.ts:compareDrafts` already does the work:
// pairwise compare, classify hard vs soft mismatches, fingerprint
// evidence for same-answer-different-evidence detection, build a
// per-criterion summary. We add two things v2 wants on top:
//   - per-cell status (auto_resolved vs needs_human) for the human queue
//   - optional Judge pre-screen on needs_human cells
//
// Subject MUST be the same across all extractor outputs (compareDrafts
// is per-patient/per-paper).

import type {
  ValidateModule, ReconciledDraft, ReconciledCell,
  ExtractorOutput, JudgeAnalysis,
} from "../../shared/types.js";
import {
  compareDrafts,
  type AgentDraft, type Disagreement,
} from "../../server/lib/disagreements.js";

export interface Judge {
  /** v1's chart-review-judge skill is the canonical implementation —
   *  port behind this interface once you want LLM pre-screening. */
  analyzeCell(cell: ReconciledCell): Promise<JudgeAnalysis>;
}

export function makeReconciler(judge?: Judge): ValidateModule {
  return {
    async reconcile(
      outputs: ExtractorOutput[],
      opts: { runJudge?: boolean } = {},
    ): Promise<ReconciledDraft> {
      if (outputs.length === 0) {
        throw new Error("reconcile() needs at least one ExtractorOutput");
      }
      const head = outputs[0];
      for (const o of outputs) {
        if (o.task_id !== head.task_id || o.subject_id !== head.subject_id) {
          throw new Error("all outputs must share task_id + subject_id");
        }
      }

      // Hand off to v1's pairwise comparator. We adapt ExtractorOutput
      // → v1's AgentDraft shape (just rename subject_id → patient_id;
      // v1's mental model is patient-centric but the comparison logic
      // is domain-agnostic).
      const drafts: AgentDraft[] = outputs.map((o) => ({
        agent_id: o.extractor_id,
        patient_id: o.subject_id,
        field_assessments: o.cells,
      }));
      const summary = compareDrafts(drafts);

      // Build per-cell ReconciledCells. v1's summary gives us the
      // disagreements list; everything not in it is an agreement.
      const cells = buildCells(outputs, summary.disagreements);

      // Optional Judge pre-screen for needs_human cells.
      if (opts.runJudge && judge) {
        for (const cell of cells) {
          if (cell.status === "needs_human") {
            cell.judge = await judge.analyzeCell(cell);
          }
        }
      }

      return { task_id: head.task_id, subject_id: head.subject_id, summary, cells };
    },
  };
}

/** Take v1's disagreement list + the raw extractor outputs and emit
 *  one ReconciledCell per (subject, field_id) seen. */
function buildCells(
  outputs: ExtractorOutput[],
  disagreements: Disagreement[],
): ReconciledCell[] {
  // Index disagreements by field_id for fast lookup.
  const disagreementByField = new Map<string, Disagreement>();
  for (const d of disagreements) disagreementByField.set(d.field_id, d);

  // Gather every (field_id, extractor) pair from outputs.
  const fieldIds = new Set<string>();
  for (const o of outputs) for (const c of o.cells) fieldIds.add(c.field_id);

  const cells: ReconciledCell[] = [];
  for (const field_id of fieldIds) {
    const inputs = outputs.flatMap((o) => {
      const cell = o.cells.find((c) => c.field_id === field_id);
      if (!cell) return [];
      return [{
        extractor_id: o.extractor_id,
        answer: cell.answer,
        confidence: cell.confidence ?? "medium",
        evidence: cell.evidence ?? [],
      }];
    });

    const dis = disagreementByField.get(field_id);
    let reconciliation: ReconciledCell["reconciliation"];
    let status: ReconciledCell["status"];

    if (dis) {
      reconciliation = dis.kind === "hard" ? "disagreed_hard" : "disagreed_soft";
      status = "needs_human";
    } else {
      const anyLow = inputs.some((i) => i.confidence === "low");
      const rawValues = inputs.map((i) => JSON.stringify(i.answer));
      const allRawSame = rawValues.every((v) => v === rawValues[0]);
      if (!allRawSame) {
        // Same normalized answer (else compareDrafts would've flagged
        // it) but raw values differ — that's type drift.
        reconciliation = "type_drift";
        status = "needs_human";
      } else if (anyLow) {
        reconciliation = "low_confidence";
        status = "needs_human";
      } else {
        reconciliation = "agreed";
        status = "auto_resolved";
      }
    }

    cells.push({ field_id, extractor_inputs: inputs, reconciliation, status });
  }

  return cells;
}
