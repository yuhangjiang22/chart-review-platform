import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { runDerivedAdjudicationsForPatient } from "../derived-adjudications/run-on-lock.js";
import * as classifier from "../derived-adjudications/classifier.js";
import type { DerivedAdjudication } from "../derived-adjudications/schema.js";
import type { FieldAssessment } from "../domain/review/review-state.js";

function fa(field_id: string, source: "agent" | "reviewer"): FieldAssessment {
  return {
    field_id,
    source,
    status: source === "reviewer" ? "approved" : "agent_proposed",
    updated_at: new Date().toISOString(),
    updated_by: source === "reviewer" ? "u1" : "agent_x",
  };
}

const stubResult = (field_id: string): DerivedAdjudication => ({
  patient_id: "p1",
  field_id,
  iter_id: "iter-1",
  agent_1: { answer_match_human: true, evidence_overlap_jaccard: 1, notes_read_jaccard: 1, human_evidence_seen_by_agent: true, classification: "correct", rationale_short: "ok" },
  agent_2: { answer_match_human: true, evidence_overlap_jaccard: 1, notes_read_jaccard: 1, human_evidence_seen_by_agent: true, classification: "correct", rationale_short: "ok" },
  pair: { classification: "both_correct" },
  gap_signal: { candidate: false, reason: "n/a", suggested_revision: null },
  trajectory_features: { notes_unique_to_agent_1: [], notes_unique_to_agent_2: [], notes_only_human_cited: [] },
  reviewer_comment: null,
  classifier: { model: "claude-haiku-4-5", ts: new Date().toISOString(), cost_usd: 0 },
});

describe("runDerivedAdjudicationsForPatient", () => {
  it("classifies every field and writes one record per field", async () => {
    const pilotIterDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-"));
    const spy = vi
      .spyOn(classifier, "classifyField")
      .mockImplementation(async (input) => stubResult(input.field_id));

    const result = await runDerivedAdjudicationsForPatient({
      patient_id: "p1",
      iter_id: "iter-1",
      pilotIterDir,
      fields: [
        { id: "C1", prompt: "?" },
        { id: "C2", prompt: "?" },
        { id: "C3", prompt: "?" },
      ],
      humanAssessmentsByField: { C1: fa("C1", "reviewer"), C2: fa("C2", "reviewer"), C3: fa("C3", "reviewer") },
      humanCommentsByField: { C1: "saw note 7", C2: null, C3: null },
      agent1: { agent_id: "agent_1", assessmentsByField: { C1: fa("C1","agent"), C2: fa("C2","agent"), C3: fa("C3","agent") }, auditText: "trace1" },
      agent2: { agent_id: "agent_2", assessmentsByField: { C1: fa("C1","agent"), C2: fa("C2","agent"), C3: fa("C3","agent") }, auditText: "trace2" },
      guidelineTextByField: { C1: "g1", C2: "g2", C3: "g3" },
      concurrency: 2,
    });

    expect(result.written).toBe(3);
    expect(spy).toHaveBeenCalledTimes(3);
    const written = JSON.parse(fs.readFileSync(path.join(pilotIterDir, "derived-adjudications.json"), "utf8"));
    expect(written).toHaveLength(3);
  });

  it("skips fields with no human assessment", async () => {
    const pilotIterDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-"));
    const spy = vi
      .spyOn(classifier, "classifyField")
      .mockImplementation(async (input) => stubResult(input.field_id));

    const result = await runDerivedAdjudicationsForPatient({
      patient_id: "p1",
      iter_id: "iter-1",
      pilotIterDir,
      fields: [{ id: "C1", prompt: "?" }, { id: "C2", prompt: "?" }],
      humanAssessmentsByField: { C1: fa("C1", "reviewer") },
      humanCommentsByField: {},
      agent1: { agent_id: "agent_1", assessmentsByField: { C1: fa("C1","agent") }, auditText: "" },
      agent2: { agent_id: "agent_2", assessmentsByField: { C1: fa("C1","agent") }, auditText: "" },
      guidelineTextByField: { C1: "g1", C2: "g2" },
      concurrency: 4,
    });

    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
