/**
 * Tests for the legacy-coercion shim in GET /api/pilots/:taskId/:iterId/disagreements.
 *
 * Pre-cluster-3 disagreements.json files have flat-string answers:
 *   { answers: { agent_a: "yes", agent_b: "no" } }
 *
 * The route must coerce those to AgentAnswerSlot objects so clients always
 * receive:
 *   { answers: { agent_a: { value: "yes", status: "answered" }, ... } }
 *
 * Cluster-3+ files (already shaped correctly) must pass through unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import os from "os";
import request from "supertest";
import express from "express";
import { pilotRouter } from "../adapters/http/pilot-routes.js";

// ── Temp directory + env setup ─────────────────────────────────────────────────

let TMP: string;
const originalGuidelinesRoot = process.env.CHART_REVIEW_GUIDELINES_ROOT;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "disagr-coerce-test-"));
  process.env.CHART_REVIEW_GUIDELINES_ROOT = TMP;
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  if (originalGuidelinesRoot !== undefined) {
    process.env.CHART_REVIEW_GUIDELINES_ROOT = originalGuidelinesRoot;
  } else {
    delete process.env.CHART_REVIEW_GUIDELINES_ROOT;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeDisagreementsFile(taskId: string, iterId: string, content: object): void {
  // guidelineDir(taskId) = CHART_REVIEW_GUIDELINES_ROOT/chart-review-<taskId>
  const dir = path.join(TMP, `chart-review-${taskId}`, "pilots", iterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "disagreements.json"), JSON.stringify(content, null, 2));
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(pilotRouter());
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/pilots/:taskId/:iterId/disagreements — legacy coercion", () => {
  it("coerces legacy flat-string answers to AgentAnswerSlot objects", async () => {
    const legacyFile = {
      pairs_compared: [{ agent_a: "agent_1", agent_b: "agent_2" }],
      disagreements: [
        {
          patient_id: "p1",
          field_id: "criterion_a",
          kind: "hard",
          pair: { agent_a: "agent_1", agent_b: "agent_2" },
          // Legacy shape: flat strings instead of AgentAnswerSlot objects.
          answers: { agent_a: "yes", agent_b: "no" },
          evidence: { agent_a: [], agent_b: [] },
        },
      ],
      same_answer_different_evidence_count: 0,
      by_criterion: { criterion_a: { disagreement_count: 1, hard_count: 1, soft_count: 0 } },
    };
    writeDisagreementsFile("my-task", "iter_001", legacyFile);

    const res = await request(makeApp())
      .get("/api/pilots/my-task/iter_001/disagreements")
      .expect(200);

    const dis = res.body.disagreements[0];
    // Flat "yes" → { value: "yes", status: "answered" }
    expect(dis.answers.agent_a).toEqual({ value: "yes", status: "answered" });
    expect(dis.answers.agent_b).toEqual({ value: "no", status: "answered" });
  });

  it("leaves already-correct AgentAnswerSlot objects unchanged", async () => {
    const modernFile = {
      pairs_compared: [{ agent_a: "agent_1", agent_b: "agent_2" }],
      disagreements: [
        {
          patient_id: "p2",
          field_id: "criterion_b",
          kind: "soft",
          pair: { agent_a: "agent_1", agent_b: "agent_2" },
          // Cluster-3 shape: already an AgentAnswerSlot.
          answers: {
            agent_a: { value: "yes", status: "answered" },
            agent_b: { value: null, status: "skipped" },
          },
          evidence: { agent_a: [], agent_b: [] },
        },
      ],
      same_answer_different_evidence_count: 0,
      by_criterion: {},
    };
    writeDisagreementsFile("my-task", "iter_002", modernFile);

    const res = await request(makeApp())
      .get("/api/pilots/my-task/iter_002/disagreements")
      .expect(200);

    const dis = res.body.disagreements[0];
    expect(dis.answers.agent_a).toEqual({ value: "yes", status: "answered" });
    expect(dis.answers.agent_b).toEqual({ value: null, status: "skipped" });
  });

  it("coerces object-without-status as answered with value preserved", async () => {
    const legacyFile = {
      pairs_compared: [],
      disagreements: [
        {
          patient_id: "p3",
          field_id: "criterion_c",
          kind: "hard",
          pair: { agent_a: "a1", agent_b: "a2" },
          // Object shape but missing `status` — defensive coercion case.
          answers: { agent_a: { value: "no_info" }, agent_b: { value: "true" } },
          evidence: { agent_a: [], agent_b: [] },
        },
      ],
      same_answer_different_evidence_count: 0,
      by_criterion: {},
    };
    writeDisagreementsFile("my-task", "iter_003", legacyFile);

    const res = await request(makeApp())
      .get("/api/pilots/my-task/iter_003/disagreements")
      .expect(200);

    const dis = res.body.disagreements[0];
    expect(dis.answers.agent_a).toEqual({ value: "no_info", status: "answered" });
    expect(dis.answers.agent_b).toEqual({ value: "true", status: "answered" });
  });

  it("preserves top-level summary fields untouched", async () => {
    const file = {
      pairs_compared: [{ agent_a: "a1", agent_b: "a2" }],
      disagreements: [],
      same_answer_different_evidence_count: 7,
      by_criterion: { c1: { disagreement_count: 2, hard_count: 1, soft_count: 1 } },
    };
    writeDisagreementsFile("my-task", "iter_004", file);

    const res = await request(makeApp())
      .get("/api/pilots/my-task/iter_004/disagreements")
      .expect(200);

    expect(res.body.same_answer_different_evidence_count).toBe(7);
    expect(res.body.by_criterion).toEqual(file.by_criterion);
    expect(res.body.pairs_compared).toEqual(file.pairs_compared);
  });
});
