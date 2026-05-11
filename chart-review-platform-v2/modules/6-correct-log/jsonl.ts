// Correct + log module — uses v1's audit-trail.
//
// v1 already has the audit infrastructure: AuditCoordinates +
// appendAuditEntry write to `<reviewsRoot>/<patientId>/<taskId>/chat/
// <sessionId>.jsonl` in v1's canonical layout. We reuse that writer
// here so v2's audit logs are bit-identical to v1's chat audit logs
// (same file layout, same JSONL shape, same parsers downstream).
//
// Human confirm/override decisions encode as `tool_call_pre` +
// `tool_call_post` entries with tool_name = "human_confirm" or
// "human_override" — fits inside v1's existing AuditEntry union without
// modifying v1.

import fs from "node:fs";
import path from "node:path";
import type {
  CorrectLogModule, FinalizedAssessment, FinalizedCell, HumanDecision,
  ReconciledDraft,
} from "../../shared/types.js";
import {
  appendAuditEntry, readAuditEntries, type AuditCoordinates, type AuditEntry,
} from "../../server/lib/audit-trail.js";

export interface CorrectLogOpts {
  /** Reviews root override (mapped to CHART_REVIEW_REVIEWS_ROOT for v1's
   *  audit-trail. The smoke test sets this; production gets it from .env). */
  reviewsRoot: string;
}

export function makeCorrectLog(opts: CorrectLogOpts): CorrectLogModule & {
  seed: (draft: ReconciledDraft, sessionId?: string) => Promise<FinalizedAssessment>;
} {
  // v1's audit-trail consults process.env.CHART_REVIEW_REVIEWS_ROOT on
  // every call, so setting it here keeps the writer pointed at v2's
  // var dir. (Workflows that already set this env var don't need this.)
  process.env.CHART_REVIEW_REVIEWS_ROOT = opts.reviewsRoot;

  function snapshotPath(task_id: string, subject_id: string): string {
    return path.join(opts.reviewsRoot, subject_id, task_id, "finalized.json");
  }

  async function readSnapshot(task_id: string, subject_id: string): Promise<FinalizedAssessment | null> {
    const fp = snapshotPath(task_id, subject_id);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(await fs.promises.readFile(fp, "utf8")) as FinalizedAssessment;
  }
  async function writeSnapshot(state: FinalizedAssessment): Promise<void> {
    const fp = snapshotPath(state.task_id, state.subject_id);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    await fs.promises.writeFile(fp, JSON.stringify(state, null, 2));
  }
  function makeCoords(task_id: string, subject_id: string, sessionId?: string): AuditCoordinates {
    // v1's AuditCoordinates is (patientId, taskId, sessionId); v2's
    // subject_id maps onto patientId. Session id is a stable
    // "human-validation" string when not provided so all decisions for
    // one subject land in one .jsonl file.
    return {
      patientId: subject_id,
      taskId: task_id,
      sessionId: sessionId ?? "human-validation",
    };
  }

  return {
    /** Seed a fresh FinalizedAssessment from the reconciliation output
     *  and write a "session_start" entry to v1's audit log. */
    async seed(draft: ReconciledDraft, sessionId?: string): Promise<FinalizedAssessment> {
      const cells: FinalizedCell[] = draft.cells.map((c) => {
        const agentInput = c.extractor_inputs[0];
        return {
          field_id: c.field_id,
          answer: c.judge?.suggested_answer ?? agentInput?.answer ?? null,
          confidence: c.judge?.confidence ?? agentInput?.confidence ?? "low",
          evidence: c.judge?.evidence_pointers ?? agentInput?.evidence ?? [],
          rationale: c.judge?.reasoning ?? "(seeded from first extractor)",
          source: c.judge ? "judge" : "agent",
          override_of_agent: false,
        };
      });
      const state: FinalizedAssessment = {
        task_id: draft.task_id,
        subject_id: draft.subject_id,
        cells,
        audit_log: [],
      };
      await writeSnapshot(state);

      const coords = makeCoords(draft.task_id, draft.subject_id, sessionId);
      const startEntry: AuditEntry = {
        ts: new Date().toISOString(),
        session_id: coords.sessionId,
        step_type: "session_start",
        patient_id: draft.subject_id,
        task_id: draft.task_id,
        model: "(human-validation)",
        cwd: opts.reviewsRoot,
      };
      appendAuditEntry(coords, startEntry);
      return state;
    },

    async recordDecision(
      task_id: string,
      subject_id: string,
      field_id: string,
      decision: HumanDecision,
    ): Promise<FinalizedAssessment> {
      const state = await readSnapshot(task_id, subject_id);
      if (!state) throw new Error(`no snapshot for ${task_id}/${subject_id} — seed first`);

      const idx = state.cells.findIndex((c) => c.field_id === field_id);
      if (idx < 0) throw new Error(`unknown field_id ${field_id}`);
      const before = state.cells[idx];

      let after: FinalizedCell;
      if (decision.action === "confirm") {
        after = { ...before };
      } else {
        if (!decision.edit_reason) throw new Error("override decisions must include edit_reason");
        after = {
          ...before,
          answer: decision.answer ?? before.answer,
          source: "human",
          override_of_agent: before.source !== "human",
          edit_reason: decision.edit_reason,
          edit_note: decision.edit_note,
        };
      }
      state.cells[idx] = after;

      // Encode as a tool_call_pre + tool_call_post pair so the entry
      // fits inside v1's existing AuditEntry union. The tool_name
      // identifies the decision flavor; tool_input carries the
      // structured payload.
      const coords = makeCoords(task_id, subject_id);
      const tool_use_id = `human-${Date.now()}`;
      const tool_name = decision.action === "confirm" ? "human_confirm" : "human_override";
      const ts = new Date().toISOString();

      const pre: AuditEntry = {
        ts,
        session_id: coords.sessionId,
        step_type: "tool_call_pre",
        tool_use_id,
        tool_name,
        tool_input: {
          field_id,
          actor: decision.actor,
          before: before.answer,
          decision: { ...decision, answer: undefined, edit_note: decision.edit_note },
        },
      };
      const post: AuditEntry = {
        ts,
        session_id: coords.sessionId,
        step_type: "tool_call_post",
        tool_use_id,
        tool_name,
        result_preview: JSON.stringify({ field_id, action: decision.action, after: after.answer }),
        result_truncated: false,
      };
      appendAuditEntry(coords, pre);
      appendAuditEntry(coords, post);

      // Mirror the high-level decision into state.audit_log (v2 own
      // running summary, separate from v1's JSONL).
      state.audit_log.push({
        ts,
        actor: decision.actor,
        action: decision.action,
        field_id,
        before: before.answer,
        after: after.answer,
        reason: decision.edit_reason,
      });
      await writeSnapshot(state);
      return state;
    },
  };
}

// Re-export so callers can inspect the v1-format JSONL log directly.
export { readAuditEntries };
