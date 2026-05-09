import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";
import { pilotRouter } from "../adapters/http/pilot-routes.js";
import * as revisitsModule from "../derived-adjudications/revisits.js";

function appWithRouter(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(pilotRouter());
  return app;
}

describe("GET /api/pilots/:taskId/:iterId/revisits", () => {
  it("returns rows from computeRevisitsForIter", async () => {
    const stub = {
      rows: [
        {
          field_id: "C1",
          field_prompt_current: "is it confirmed?",
          patient_id: "p1",
          prior_answer: "yes",
          prior_evidence: [],
          prior_rationale: "old rationale",
          agent_rerun_answer: "no",
          agent_rerun_rationale: "new rationale",
          prior_captured_hash: "old1234aaaaaaaa",
          current_hash: "new5678bbbbbbbb",
        },
      ],
      criteria_changed: 1,
      total: 1,
    };
    vi.spyOn(revisitsModule, "computeRevisitsForIter").mockReturnValue(stub);
    const app = appWithRouter();
    const res = await request(app).get("/api/pilots/test_task/iter_001/revisits");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].field_id).toBe("C1");
    expect(res.body.criteria_changed).toBe(1);
    expect(res.body.total).toBe(1);
  });

  it("returns ok=true with empty rows when no revisits exist", async () => {
    vi.spyOn(revisitsModule, "computeRevisitsForIter").mockReturnValue({
      rows: [],
      criteria_changed: 0,
      total: 0,
    });
    const app = appWithRouter();
    const res = await request(app).get("/api/pilots/test_task/iter_002/revisits");
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

describe("POST /api/pilots/:taskId/:iterId/revisits/bulk-keep", () => {
  it("returns 200 with the count of records bumped", async () => {
    const bulk = vi.fn().mockResolvedValue({ bumped: 5 });
    vi.spyOn(revisitsModule, "bulkKeepRevisits").mockImplementation(bulk);
    const app = appWithRouter();
    const res = await request(app)
      .post("/api/pilots/test_task/iter_001/revisits/bulk-keep")
      .send({ field_id: "C1" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.bumped).toBe(5);
    expect(bulk).toHaveBeenCalledWith({
      taskId: "test_task",
      fieldId: "C1",
      patientIds: undefined,
      reviewerId: expect.any(String),
    });
  });

  it("scopes to specific patient_ids when provided", async () => {
    const bulk = vi.fn().mockResolvedValue({ bumped: 2 });
    vi.spyOn(revisitsModule, "bulkKeepRevisits").mockImplementation(bulk);
    const app = appWithRouter();
    const res = await request(app)
      .post("/api/pilots/test_task/iter_001/revisits/bulk-keep")
      .send({ field_id: "C1", patient_ids: ["p1", "p2"] });
    expect(res.status).toBe(200);
    expect(res.body.bumped).toBe(2);
    expect(bulk).toHaveBeenCalledWith({
      taskId: "test_task",
      fieldId: "C1",
      patientIds: ["p1", "p2"],
      reviewerId: expect.any(String),
    });
  });

  it("400 when field_id is missing", async () => {
    const app = appWithRouter();
    const res = await request(app)
      .post("/api/pilots/test_task/iter_001/revisits/bulk-keep")
      .send({});
    expect(res.status).toBe(400);
  });
});
