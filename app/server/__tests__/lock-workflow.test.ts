import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import { applyUiAction, applySetAssessment, ReviewStateError } from "../domain/review/index.js";
import { lockReadyCheck, computeTaskSha } from "../lock.js";
import { reviewerRouter } from "../routes-reviewer.js";
import { PLATFORM_ROOT } from "../patients.js";
import { seedSkillBundle } from "./helpers/seedSkillBundle.js";

// Guideline root used by tasks.ts — packages live at guidelines/<taskId>/meta.yaml.
const BUNDLE_DIR = path.join(PLATFORM_ROOT, "guidelines");

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
  // Clean up the test guideline fixture (both the YAML bundle and the
  // skill-format markdown directory that seedSkillBundle now writes).
  const bundleDir = path.join(BUNDLE_DIR, TID);
  if (fs.existsSync(bundleDir)) fs.rmSync(bundleDir, { recursive: true, force: true });
  const skillDir = path.join(PLATFORM_ROOT, ".claude", "skills", `chart-review-${TID}`);
  if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });
});

const PID = "p1", TID = "t1";
const TASK = { task_id: TID, source_document_sha: "sha", fields: [{ id: "x" }] };

function readState() {
  return JSON.parse(fs.readFileSync(path.join(TMP, PID, TID, "review_state.json"), "utf8"));
}

/**
 * Seed a minimal guideline package to guidelines/<TID>/ so that
 * loadCompiledTask() can find it. The afterEach hook cleans it up.
 */
function writeCompiledTask(): string {
  seedSkillBundle(PLATFORM_ROOT, TID, {
    source_document_sha: "sha",
    fields: [{ id: "x" }],
  });
  return path.join(BUNDLE_DIR, TID);
}

/** Spin up a throw-away Express server and return { url, close }. */
function makeServer(): { url: string; close: () => Promise<void> } {
  const app = express();
  app.use(express.json());
  // Inject reviewer_id directly (bypass auth token lookup for tests)
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).reviewer_id = "alice";
    next();
  });
  app.use(reviewerRouter(() => {}));
  const server = http.createServer(app);
  return {
    url: (() => {
      server.listen(0); // bind to a random available port
      const addr = server.address() as { port: number };
      return `http://127.0.0.1:${addr.port}`;
    })(),
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}

describe("lock guard in applyUiAction", () => {
  it("rejects writes once review_status is locked", () => {
    // Set up: agent writes, then transition to locked
    applySetAssessment(PID, TASK, "agent", "agent-1", {
      field_id: "x", answer: "yes", status: "agent_proposed",
    });
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "locked", locked_at: "2026-04-29T15:00:00Z", locked_by: "alice", lock_task_sha: "abc123" }
    });

    expect(readState().review_status).toBe("locked");

    // Now try a reviewer write
    expect(() =>
      applySetAssessment(PID, TASK, "reviewer", "alice", {
        field_id: "x", answer: "no", status: "overridden",
      })
    ).toThrow(expect.objectContaining({ code: "RECORD_LOCKED" }));

    // And an agent write
    expect(() =>
      applySetAssessment(PID, TASK, "agent", "agent-2", {
        field_id: "x", answer: "maybe", status: "agent_proposed",
      })
    ).toThrow(expect.objectContaining({ code: "RECORD_LOCKED" }));
  });

  it("allows the transitioning write into locked state", () => {
    // Pre-state: validated
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "reviewer_validated" }
    });
    expect(readState().review_status).toBe("reviewer_validated");

    // The lock-transitioning write itself succeeds
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "locked", locked_at: "2026-04-29T15:00:00Z", locked_by: "alice", lock_task_sha: "abc123" }
    });
    const s = readState();
    expect(s.review_status).toBe("locked");
    expect(s.locked_at).toBe("2026-04-29T15:00:00Z");
    expect(s.locked_by).toBe("alice");
    expect(s.lock_task_sha).toBe("abc123");
  });
});

// ── lock.ts unit tests ────────────────────────────────────────────────────────

describe("lockReadyCheck", () => {
  it("returns ready=false when status is not reviewer_validated", () => {
    for (const status of ["draft", "in_progress", "agent_complete", "locked", undefined]) {
      const result = lockReadyCheck(status);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/reviewer_validated/);
    }
  });

  it("returns ready=true when status is reviewer_validated", () => {
    const result = lockReadyCheck("reviewer_validated");
    expect(result.ready).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe("computeTaskSha", () => {
  it("returns a 16-char lowercase hex string", () => {
    const tmpFile = path.join(os.tmpdir(), `sha-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ task_id: "test" }), "utf8");
    try {
      const sha = computeTaskSha(tmpFile);
      expect(sha).toMatch(/^[a-f0-9]{16}$/);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it("produces a different SHA for different content", () => {
    const f1 = path.join(os.tmpdir(), `sha-a-${Date.now()}.json`);
    const f2 = path.join(os.tmpdir(), `sha-b-${Date.now()}.json`);
    fs.writeFileSync(f1, JSON.stringify({ task_id: "alpha" }), "utf8");
    fs.writeFileSync(f2, JSON.stringify({ task_id: "beta" }), "utf8");
    try {
      expect(computeTaskSha(f1)).not.toBe(computeTaskSha(f2));
    } finally {
      fs.rmSync(f1, { force: true });
      fs.rmSync(f2, { force: true });
    }
  });
});

// ── POST /lock endpoint integration tests ─────────────────────────────────────

describe("POST /api/reviews/:pid/:tid/lock endpoint", () => {
  it("returns 409 when review_status is not reviewer_validated", async () => {
    // Seed the guideline package so loadCompiledTask() finds it
    writeCompiledTask();

    // Put state in-progress (not validated)
    applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_field_assessment",
      payload: { field_id: "x", answer: "yes", status: "approved" },
    });

    const { url, close } = makeServer();
    try {
      const res = await fetch(`${url}/api/reviews/${PID}/${TID}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(409);
      const body = await res.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/reviewer_validated/);
    } finally {
      await close();
    }
  });

  it("returns 404 when review_state does not exist", async () => {
    // No review_state.json exists for nobody/notask — expect 404

    const { url, close } = makeServer();
    try {
      const res = await fetch(`${url}/api/reviews/nobody/notask/lock`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it("locks a validated record, persists lock fields, and emits record_locked audit", async () => {
    // Write compiled task so both loadCompiledTask and computeTaskSha succeed
    writeCompiledTask();

    // Transition to reviewer_validated first
    applyUiAction(PID, TASK, "reviewer", "alice", {
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
      const body = await res.json() as {
        ok: boolean;
        version: number;
        lock_task_sha: string;
        locked_at: string;
      };
      expect(body.ok).toBe(true);
      expect(body.lock_task_sha).toMatch(/^[a-f0-9]{16}$/);
      expect(body.locked_at).toBeTruthy();

      // Verify persisted state
      const state = readState();
      expect(state.review_status).toBe("locked");
      expect(state.lock_task_sha).toBe(body.lock_task_sha);
      expect(state.locked_by).toBe("alice");
      expect(state.locked_at).toBe(body.locked_at);

      // Verify audit entry
      const chatDir = path.join(TMP, PID, TID, "chat");
      const entries = fs.readdirSync(chatDir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) =>
          fs.readFileSync(path.join(chatDir, f), "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as { step_type: string; lock_task_sha?: string }),
        );
      const lockEntry = entries.find((e) => e.step_type === "record_locked");
      expect(lockEntry).toBeTruthy();
      expect(lockEntry?.lock_task_sha).toBe(body.lock_task_sha);
    } finally {
      await close();
    }
  });
});
