import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const {
  mockGetPilotManifest,
  mockStartPilotIteration,
  mockTransitionIterToRevising,
  mockSnapshotHashes,
  mockReadCohortSampling,
  mockIsMethodologist,
  mockReviewerIdOf,
} = vi.hoisted(() => ({
  mockGetPilotManifest: vi.fn(),
  mockStartPilotIteration: vi.fn(),
  mockTransitionIterToRevising: vi.fn(),
  mockSnapshotHashes: vi.fn(),
  mockReadCohortSampling: vi.fn(),
  mockIsMethodologist: vi.fn().mockReturnValue(true),
  mockReviewerIdOf: vi.fn().mockReturnValue("methodologist@example.com"),
}));

vi.mock("../domain/iter/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPilotManifest: mockGetPilotManifest,
    startPilotIteration: mockStartPilotIteration,
    transitionIterToRevising: mockTransitionIterToRevising,
    snapshotCriterionHashesSync: mockSnapshotHashes,
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn() };
});
vi.mock("../auth.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    isMethodologist: mockIsMethodologist,
    reviewerIdOf: mockReviewerIdOf,
  };
});
vi.mock("../domain/cohort/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    readCohortSampling: mockReadCohortSampling,
  };
});

import { pilotRouter } from "../adapters/http/pilot-routes.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(pilotRouter());
  return app;
}

const SOURCE_MANIFEST = {
  task_id: "task1", iter_id: "iter_001", iter_num: 1, run_id: "r1",
  guideline_sha: "abc", started_at: "2026-05-06T00:00:00Z",
  started_by: "method", state: "complete",
  criterion_schema_hashes: { C1: "hash-old", C2: "hash-stable" },
};
const NEW_MANIFEST = {
  ...SOURCE_MANIFEST, iter_id: "iter_002", iter_num: 2, state: "running",
  criterion_schema_hashes: { C1: "hash-new", C2: "hash-stable" },
};

describe("POST /api/versions/:taskId/:vTag/revise", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMethodologist.mockReturnValue(true);
    mockReviewerIdOf.mockReturnValue("methodologist@example.com");
    mockGetPilotManifest.mockReturnValue(SOURCE_MANIFEST);
    mockTransitionIterToRevising.mockReturnValue({ ...SOURCE_MANIFEST, state: "revising" });
    mockStartPilotIteration.mockReturnValue({ pilot: NEW_MANIFEST });
    mockSnapshotHashes.mockReturnValue({ C1: "hash-new", C2: "hash-stable" });
    mockReadCohortSampling.mockReturnValue({ dev_patient_ids: ["p1", "p2"] });
  });

  it("returns 201 with new_version_tag and stale_cells", async () => {
    const res = await request(buildApp())
      .post("/api/versions/task1/iter_001/revise")
      .set("x-reviewer-id", "methodologist@example.com")
      .send({
        criteria_edits: [{ field_id: "C1", new_yaml: "id: C1\nprompt: updated\n" }],
      });
    expect(res.status).toBe(201);
    expect(res.body.new_version_tag).toBe("iter_002");
    expect(res.body.stale_cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field_id: "C1" }),
      ]),
    );
    expect(res.body.source_iter_state).toBe("revising");
  });

  it("returns 404 when source iter not found", async () => {
    mockGetPilotManifest.mockReturnValue(null);
    const res = await request(buildApp())
      .post("/api/versions/task1/iter_999/revise")
      .set("x-reviewer-id", "methodologist@example.com")
      .send({ criteria_edits: [] });
    expect(res.status).toBe(404);
  });

  it("returns 422 when criteria_edits is missing", async () => {
    const res = await request(buildApp())
      .post("/api/versions/task1/iter_001/revise")
      .set("x-reviewer-id", "methodologist@example.com")
      .send({});
    expect(res.status).toBe(422);
  });

  it("applies patient_sample_change add/remove", async () => {
    const res = await request(buildApp())
      .post("/api/versions/task1/iter_001/revise")
      .set("x-reviewer-id", "methodologist@example.com")
      .send({
        criteria_edits: [],
        patient_sample_change: { add: ["p3"], remove: ["p1"] },
      });
    expect(res.status).toBe(201);
    const callArgs = mockStartPilotIteration.mock.calls[0][0];
    expect(callArgs.patient_ids).toContain("p3");
    expect(callArgs.patient_ids).not.toContain("p1");
  });
});
