/**
 * Task 6: lock-route derived-adjudication classifier wiring tests.
 *
 * Two tiers of coverage:
 *
 *   Tier 1 — pure-function unit tests for resolvePilotContext and
 *             loadGuidelineTextByField (no mocking needed, just filesystem).
 *
 *   Tier 2 — lock-route integration test using the Express harness from
 *             lock-workflow.test.ts, with classifyField mocked via vi.mock
 *             to avoid the LLM, and resolvePilotContext mocked to bypass
 *             the pilot manifest lookup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";

// ─── Module mocks (hoisted by vitest — must be at top, no closure refs) ───────

vi.mock("../derived-adjudications/classifier.js", () => ({
  classifyField: vi.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { loadGuidelineTextByField, resolvePilotContext } from "../derived-adjudications/lock-helpers.js";
import * as classifier from "../derived-adjudications/classifier.js";
import { applyUiAction } from "../domain/review/index.js";
import { reviewerRouter } from "../routes-reviewer.js";
import { PLATFORM_ROOT } from "../patients.js";
import { seedSkillBundle } from "./helpers/seedSkillBundle.js";
import type { CompiledTask } from "../tasks.js";
import type { DerivedAdjudication } from "../derived-adjudications/schema.js";
import type { FieldAssessment } from "../domain/review/review-state.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const BUNDLE_DIR = path.join(PLATFORM_ROOT, "guidelines");
const PID = "lock-adj-p1";
const TID = "lock-adj-t1";
const ITER_ID = "iter_001";

// ─── Tier 1: pure-function unit tests ────────────────────────────────────────

describe("loadGuidelineTextByField", () => {
  it("returns a map of field_id -> concatenated text", () => {
    const task: CompiledTask = {
      task_id: "t1",
      source_document_sha: "sha",
      fields: [
        { id: "C1", prompt: "Criterion 1 prompt" },
        { id: "C2", prompt: "Criterion 2 prompt" },
      ],
    };
    const result = loadGuidelineTextByField(task);
    expect(result["C1"]).toContain("Criterion 1 prompt");
    expect(result["C2"]).toContain("Criterion 2 prompt");
    expect(Object.keys(result)).toEqual(["C1", "C2"]);
  });

  it("concatenates guidance_md and rules_summary when present", () => {
    const fieldWithExtras = {
      id: "C1",
      prompt: "Prompt text",
    } as any;
    fieldWithExtras.guidance_md = "Guidance";
    fieldWithExtras.rules_summary = "Rules";

    const task = {
      task_id: "t1",
      source_document_sha: "sha",
      fields: [fieldWithExtras],
    } as CompiledTask;

    const result = loadGuidelineTextByField(task);
    expect(result["C1"]).toContain("Prompt text");
    expect(result["C1"]).toContain("Guidance");
    expect(result["C1"]).toContain("Rules");
  });

  it("handles fields with no prompt gracefully", () => {
    const task: CompiledTask = {
      task_id: "t1",
      source_document_sha: "sha",
      fields: [{ id: "C1" }],
    };
    const result = loadGuidelineTextByField(task);
    expect(result["C1"]).toBe("");
  });

  it("returns empty object for a task with no fields", () => {
    const task: CompiledTask = {
      task_id: "t1",
      source_document_sha: "sha",
      fields: [],
    };
    expect(loadGuidelineTextByField(task)).toEqual({});
  });
});

// ─── resolvePilotContext unit test ────────────────────────────────────────────

describe("resolvePilotContext", () => {
  it("returns null when the pilot manifest does not exist", () => {
    const result = resolvePilotContext("nonexistent-task-xyz", "iter_001");
    expect(result).toBeNull();
  });

  it("returns PilotContext when a valid manifest exists", () => {
    const taskId = `task-ctx-${Date.now()}`;
    const iterId = "iter_001";
    const runId = `run_${Date.now()}`;

    // Write a minimal manifest into the skill dir location
    const skillDir = path.join(PLATFORM_ROOT, ".claude", "skills", `chart-review-${taskId}`);
    const pilotsDir = path.join(skillDir, "pilots", iterId);
    fs.mkdirSync(pilotsDir, { recursive: true });
    const manifest = {
      task_id: taskId,
      iter_id: iterId,
      iter_num: 1,
      run_id: runId,
      guideline_sha: "abc",
      started_at: new Date().toISOString(),
      started_by: "test",
      state: "running",
    };
    fs.writeFileSync(path.join(pilotsDir, "manifest.json"), JSON.stringify(manifest));

    try {
      const ctx = resolvePilotContext(taskId, iterId);
      expect(ctx).not.toBeNull();
      expect(ctx!.iter_id).toBe(iterId);
      expect(ctx!.run_id).toBe(runId);
      expect(ctx!.pilotIterDir).toContain(iterId);
      expect(ctx!.runDir).toContain(runId);
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
  });
});

// ─── Tier 2: lock-route integration tests ────────────────────────────────────

const STUB_RESULT = (field_id: string): DerivedAdjudication => ({
  patient_id: PID,
  field_id,
  iter_id: ITER_ID,
  agent_1: {
    answer_match_human: true,
    evidence_overlap_jaccard: 1,
    notes_read_jaccard: 1,
    human_evidence_seen_by_agent: true,
    classification: "correct",
    rationale_short: "ok",
  },
  agent_2: {
    answer_match_human: true,
    evidence_overlap_jaccard: 1,
    notes_read_jaccard: 1,
    human_evidence_seen_by_agent: true,
    classification: "correct",
    rationale_short: "ok",
  },
  pair: { classification: "both_correct" },
  gap_signal: { candidate: false, reason: "n/a", suggested_revision: null },
  trajectory_features: {
    notes_unique_to_agent_1: [],
    notes_unique_to_agent_2: [],
    notes_only_human_cited: [],
  },
  reviewer_comment: null,
  classifier: { model: "claude-haiku-4-5", ts: new Date().toISOString(), cost_usd: 0 },
});

let TMP: string;
let pilotIterDirForTest: string;
let runDirForTest: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lock-adj-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;

  // Create a temp run dir with agent drafts
  runDirForTest = fs.mkdtempSync(path.join(os.tmpdir(), "runs-lock-adj-"));
  const agentsDir = path.join(runDirForTest, "per_patient", PID, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  const agentDraft = {
    field_assessments: [
      {
        field_id: "C1",
        answer: "yes",
        source: "agent",
        status: "agent_proposed",
        updated_at: new Date().toISOString(),
        updated_by: "agent_1",
      } as FieldAssessment,
    ],
  };
  fs.writeFileSync(path.join(agentsDir, "agent_1.json"), JSON.stringify(agentDraft));
  fs.writeFileSync(path.join(agentsDir, "agent_2.json"), JSON.stringify(agentDraft));

  // Create a pilot iter dir (used by resolvePilotContext mock return value)
  pilotIterDirForTest = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-iter-lock-adj-"));
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  if (fs.existsSync(runDirForTest)) fs.rmSync(runDirForTest, { recursive: true, force: true });
  if (fs.existsSync(pilotIterDirForTest)) fs.rmSync(pilotIterDirForTest, { recursive: true, force: true });

  delete process.env.CHART_REVIEW_REVIEWS_ROOT;

  const bundleDir = path.join(BUNDLE_DIR, TID);
  if (fs.existsSync(bundleDir)) fs.rmSync(bundleDir, { recursive: true, force: true });
  const skillDir = path.join(PLATFORM_ROOT, ".claude", "skills", `chart-review-${TID}`);
  if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });

  vi.restoreAllMocks();
});

/** Spin up a minimal Express server for testing the reviewer routes. */
function makeServer(): { url: string; close: () => Promise<void> } {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).reviewer_id = "alice";
    next();
  });
  app.use(reviewerRouter(() => {}));
  const server = http.createServer(app);
  server.listen(0);
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}

function seedTask() {
  seedSkillBundle(PLATFORM_ROOT, TID, {
    source_document_sha: "sha",
    fields: [{ id: "C1", prompt: "Is C1 present?" }],
  });
}

const STUB_TASK = { task_id: TID, source_document_sha: "sha", fields: [{ id: "C1" }] };

describe("POST /api/reviews/:pid/:tid/lock — derived-adjudication integration", () => {
  it("(a) calls classifyField when iter_id supplied and pilot context resolves", async () => {
    seedTask();
    applyUiAction(PID, STUB_TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "reviewer_validated" },
    });

    // Spy on resolvePilotContext to return a context pointing at our tmp dirs
    const { resolvePilotContext: helperModule } = await import("../derived-adjudications/lock-helpers.js");
    vi.spyOn(
      await import("../derived-adjudications/lock-helpers.js"),
      "resolvePilotContext",
    ).mockReturnValue({
      iter_id: ITER_ID,
      run_id: `run_${Date.now()}`,
      pilotIterDir: pilotIterDirForTest,
      runDir: runDirForTest,
    });

    vi.mocked(classifier.classifyField).mockResolvedValue(STUB_RESULT("C1"));

    const { url, close } = makeServer();
    try {
      const res = await fetch(`${url}/api/reviews/${PID}/${TID}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iter_id: ITER_ID }),
      });
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("(b) lock still returns 200 when classifyField throws", async () => {
    seedTask();
    applyUiAction(PID, STUB_TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "reviewer_validated" },
    });

    vi.mocked(classifier.classifyField).mockRejectedValue(new Error("LLM down"));

    const { url, close } = makeServer();
    try {
      const res = await fetch(`${url}/api/reviews/${PID}/${TID}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iter_id: ITER_ID }),
      });
      // Lock still succeeds despite classifier failure
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await close();
    }
  });

  it("lock still returns 200 when iter_id is omitted (legacy non-pilot lock)", async () => {
    seedTask();
    applyUiAction(PID, STUB_TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "reviewer_validated" },
    });

    const { url, close } = makeServer();
    try {
      const res = await fetch(`${url}/api/reviews/${PID}/${TID}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
      // classifyField should NOT have been called (no pilot context)
      expect(vi.mocked(classifier.classifyField)).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
