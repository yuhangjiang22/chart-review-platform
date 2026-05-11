// Judge adapter — wraps v1's judgeCell (chart-review-judge skill).
//
// v1's `judge.ts:judgeCell` runs a single (patient, criterion) cell
// through the chart-review-judge skill via runAgent. It produces a
// strict-JSON JudgeAnalysis (suggested_answer + reasoning + evidence
// pointers + agent_correctness + classification_hint + confidence).
//
// v2's Judge interface expects per-cell analysis; this adapter
// translates v2's ReconciledCell shape into v1's JudgeInput shape,
// calls judgeCell, and translates the v1 JudgeAnalysis back into
// v2's smaller JudgeAnalysis shape.

import type { Judge } from "./reconcile.js";
import type {
  ReconciledCell, JudgeAnalysis as V2JudgeAnalysis, ProviderName,
} from "../../shared/types.js";
import {
  judgeCell, type JudgeInput, type JudgeAgentSnapshot,
} from "../../../chart-review-platform/app/server/judge.js";

export interface V1JudgeAdapterOptions {
  taskId: string;
  /** Which subject (patient/paper) the cells came from. v1's judge
   *  works in chart-review terms; lit-extract callers can reuse this
   *  with a subject_id that points at a paper directory laid out like
   *  v1's patient corpus. */
  patientId: string;
  /** Provider override (Claude / Codex) — passed through to runAgent.
   *  When absent, judge follows AGENT_PROVIDER env var. */
  provider?: ProviderName;
}

export function makeV1Judge(opts: V1JudgeAdapterOptions): Judge {
  return {
    async analyzeCell(cell: ReconciledCell): Promise<V2JudgeAnalysis> {
      // Translate v2's extractor_inputs[] into v1's agent_a / agent_b.
      const [a, b] = cell.extractor_inputs;
      const agent_a = inputToSnapshot(a);
      const agent_b = b ? inputToSnapshot(b) : undefined;

      // Map v2's reconciliation outcome to v1's JudgeInput.kind.
      const kind: JudgeInput["kind"] =
        cell.reconciliation === "type_drift" ? "type_drift" :
        cell.reconciliation === "low_confidence" ? "low_confidence" :
        "disagreement";

      const input: JudgeInput = {
        patientId: opts.patientId,
        taskId: opts.taskId,
        fieldId: cell.field_id,
        kind,
        agent_a,
        ...(agent_b ? { agent_b } : {}),
        ...(opts.provider ? { provider: opts.provider } : {}),
      };

      const out = await judgeCell(input);
      if (!out.ok || !out.analysis) {
        // Surface the failure as a low-confidence "judge could not
        // analyze" suggestion rather than throwing; the human still
        // sees the cell in their queue.
        return {
          suggested_answer: null,
          reasoning: `(v1 judge failed: ${out.error ?? "unknown"})`,
          confidence: "low",
        };
      }

      // Translate v1's richer JudgeAnalysis into v2's smaller shape.
      // v2 doesn't currently surface agent_correctness or
      // classification_hint; those stay on disk in v1's chat audit
      // log if you want them for analytics.
      return {
        suggested_answer: out.analysis.suggested_answer,
        reasoning: out.analysis.reasoning,
        confidence: out.analysis.judge_confidence,
      };
    },
  };
}

function inputToSnapshot(
  inp: ReconciledCell["extractor_inputs"][number],
): JudgeAgentSnapshot {
  return {
    agent_id: inp.extractor_id,
    answer: inp.answer,
    confidence: inp.confidence,
    evidence: inp.evidence,
  };
}
