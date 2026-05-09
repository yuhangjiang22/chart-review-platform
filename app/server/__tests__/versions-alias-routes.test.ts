import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const { mockListPilotIterations, mockGetPilotManifest } = vi.hoisted(() => ({
  mockListPilotIterations: vi.fn(),
  mockGetPilotManifest: vi.fn(),
}));

vi.mock("../domain/iter/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    listPilotIterations: mockListPilotIterations,
    getPilotManifest: mockGetPilotManifest,
  };
});

import { pilotRouter } from "../adapters/http/pilot-routes.js";

function buildApp() {
  const app = express();
  app.use(pilotRouter());
  return app;
}

describe("/api/versions alias routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPilotIterations.mockReturnValue([]);
    mockGetPilotManifest.mockReturnValue(null);
  });

  it("GET /api/versions/:taskId returns same payload as GET /api/pilots/:taskId", async () => {
    mockListPilotIterations.mockReturnValue([{ iter_id: "iter_001" }]);
    const [r1, r2] = await Promise.all([
      request(buildApp()).get("/api/pilots/task1"),
      request(buildApp()).get("/api/versions/task1"),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body).toEqual(r2.body);
  });

  it("GET /api/versions/:taskId/:vTag returns 404 for unknown iter (same as pilots path)", async () => {
    const [r1, r2] = await Promise.all([
      request(buildApp()).get("/api/pilots/task1/iter_999"),
      request(buildApp()).get("/api/versions/task1/iter_999"),
    ]);
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
  });
});
