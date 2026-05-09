import { describe, it, expect } from "vitest";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";

import { writeDerivedAdjudication } from "../derived-adjudications/store.js";
import { mountDerivedAdjudicationRoutes } from "../adapters/http/review-routes.js";

function tmpIter(): { app: express.Express; pilotIterDir: string; iter_id: string } {
  const pilotIterDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-iter-"));
  const iter_id = path.basename(pilotIterDir);
  const app = express();
  // Test override: resolver returns the temp dir for this iter_id.
  mountDerivedAdjudicationRoutes(app, {
    resolvePilotIterDir: (id) => (id === iter_id ? pilotIterDir : null),
  });
  return { app, pilotIterDir, iter_id };
}

describe("GET /api/pilots/:iterId/derived-adjudications/:patientId", () => {
  it("returns the records for a patient", async () => {
    const { app, pilotIterDir, iter_id } = tmpIter();
    writeDerivedAdjudication(pilotIterDir, {
      patient_id: "p1", field_id: "C1", iter_id,
      agent_1: { answer_match_human: true, evidence_overlap_jaccard: 1, notes_read_jaccard: 1, human_evidence_seen_by_agent: true, classification: "correct", rationale_short: "ok" },
      agent_2: { answer_match_human: true, evidence_overlap_jaccard: 1, notes_read_jaccard: 1, human_evidence_seen_by_agent: true, classification: "correct", rationale_short: "ok" },
      pair: { classification: "both_correct" },
      gap_signal: { candidate: false, reason: "n/a", suggested_revision: null },
      trajectory_features: { notes_unique_to_agent_1: [], notes_unique_to_agent_2: [], notes_only_human_cited: [] },
      reviewer_comment: null,
      classifier: { model: "claude-haiku-4-5", ts: new Date().toISOString(), cost_usd: 0 },
    });
    const res = await request(app).get(`/api/pilots/${iter_id}/derived-adjudications/p1`);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].field_id).toBe("C1");
  });

  it("returns 200 with empty array when none exist for that patient", async () => {
    const { app, iter_id } = tmpIter();
    const res = await request(app).get(`/api/pilots/${iter_id}/derived-adjudications/missing`);
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
  });

  it("returns 404 when the iter does not resolve", async () => {
    const { app } = tmpIter();
    const res = await request(app).get(`/api/pilots/wrong-iter/derived-adjudications/p1`);
    expect(res.status).toBe(404);
  });
});
