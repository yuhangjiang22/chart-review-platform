import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const {
  mockComputeRevisits,
  mockGetPilotManifest,
  mockReadCohortSampling,
  mockSnapshotHashes,
} = vi.hoisted(() => ({
  mockComputeRevisits: vi.fn(),
  mockGetPilotManifest: vi.fn(),
  mockReadCohortSampling: vi.fn(),
  mockSnapshotHashes: vi.fn(),
}));

vi.mock("../derived-adjudications/revisits.js", () => ({
  computeRevisitsForIter: mockComputeRevisits,
  bulkKeepRevisits: vi.fn(),
}));
vi.mock("../domain/iter/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPilotManifest: mockGetPilotManifest,
    snapshotCriterionHashesSync: mockSnapshotHashes,
  };
});
vi.mock("../domain/cohort/index.js", () => ({
  readCohortSampling: mockReadCohortSampling,
}));

import { pilotRouter } from "../adapters/http/pilot-routes.js";

function buildApp() {
  const app = express();
  app.use(pilotRouter());
  return app;
}

const MANIFEST = {
  task_id: "task1", iter_id: "iter_001", iter_num: 1, run_id: "r1",
  guideline_sha: "abc", started_at: "2026-05-06T00:00:00Z",
  started_by: "method", state: "validating",
  criterion_schema_hashes: { C1: "hash1", C2: "hash2" },
};

describe("GET /api/versions/:taskId/:vTag/cells", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPilotManifest.mockReturnValue(MANIFEST);
    mockReadCohortSampling.mockReturnValue({ dev_patient_ids: ["p1"] });
    mockSnapshotHashes.mockReturnValue({ C1: "hash1", C2: "hash2" });
    mockComputeRevisits.mockReturnValue({
      rows: [
        {
          field_id: "C2", patient_id: "p1",
          prior_answer: true, prior_captured_hash: "hash-old",
          current_hash: "hash2", prior_evidence: [], prior_rationale: null,
          agent_rerun_answer: null, agent_rerun_rationale: null,
        },
      ],
      criteria_changed: 1, total: 1,
    });
  });

  it("returns 200 with a cells array", async () => {
    const res = await request(buildApp())
      .get("/api/versions/task1/iter_001/cells");
    expect(res.status).toBe(200);
    expect(res.body.cells).toBeDefined();
    expect(Array.isArray(res.body.cells)).toBe(true);
  });

  it("marks cell as stale when hash differs", async () => {
    const res = await request(buildApp())
      .get("/api/versions/task1/iter_001/cells");
    const stale = res.body.cells.find(
      (c: any) => c.field_id === "C2" && c.patient_id === "p1",
    );
    expect(stale?.state).toBe("stale");
  });

  it("marks cells as unvalidated when no reviewer answer", async () => {
    mockComputeRevisits.mockReturnValue({ rows: [], criteria_changed: 0, total: 0 });
    const res = await request(buildApp())
      .get("/api/versions/task1/iter_001/cells");
    expect(res.body.cells.every((c: any) => c.state === "unvalidated")).toBe(true);
  });

  it("returns 404 when iter not found", async () => {
    mockGetPilotManifest.mockReturnValue(null);
    const res = await request(buildApp())
      .get("/api/versions/task1/iter_999/cells");
    expect(res.status).toBe(404);
  });
});
