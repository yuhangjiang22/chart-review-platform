/**
 * Tests for GET /api/guideline-improvement/:taskId/analysis-summary (A5).
 *
 * Returns proposals/<taskId>/ANALYSIS_SUMMARY.md as text/markdown, or
 * 404 (not 500) when the file is absent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { guidelineRouter } from "../adapters/http/guideline-routes.js";

// ── helpers ───────────────────────────────────────────────────────────────────

let TMP: string;
const TASK_ID = "task-as";

function buildApp() {
  const app = express();
  app.use(guidelineRouter());
  return app;
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-summary-test-"));
  process.env.CHART_REVIEW_PROPOSALS_ROOT = path.join(TMP, "proposals");
  // Also set the platform root so guideline-routes can derive proposals root
  // from CHART_REVIEW_PROPOSALS_ROOT directly.
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PROPOSALS_ROOT;
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/guideline-improvement/:taskId/analysis-summary", () => {
  it("returns 200 with markdown content when ANALYSIS_SUMMARY.md exists", async () => {
    const summaryDir = path.join(TMP, "proposals", TASK_ID);
    fs.mkdirSync(summaryDir, { recursive: true });
    const content = "# Analysis Summary\n\nFound 3 clusters.\n\n- Cluster 1\n- Cluster 2";
    fs.writeFileSync(path.join(summaryDir, "ANALYSIS_SUMMARY.md"), content);

    const res = await request(buildApp()).get(
      `/api/guideline-improvement/${TASK_ID}/analysis-summary`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe(content);
    // Content-type should be markdown-ish
    expect(res.headers["content-type"]).toMatch(/markdown|text/);
  });

  it("returns 404 (not 500) when ANALYSIS_SUMMARY.md is absent", async () => {
    // proposals dir exists but no ANALYSIS_SUMMARY.md
    const summaryDir = path.join(TMP, "proposals", TASK_ID);
    fs.mkdirSync(summaryDir, { recursive: true });

    const res = await request(buildApp()).get(
      `/api/guideline-improvement/${TASK_ID}/analysis-summary`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it("returns 404 when the proposals directory for the task does not exist", async () => {
    // proposals root exists but no sub-dir for this task
    fs.mkdirSync(path.join(TMP, "proposals"), { recursive: true });

    const res = await request(buildApp()).get(
      `/api/guideline-improvement/${TASK_ID}/analysis-summary`,
    );
    expect(res.status).toBe(404);
  });

  it("returns the full file content verbatim (no truncation)", async () => {
    const summaryDir = path.join(TMP, "proposals", TASK_ID);
    fs.mkdirSync(summaryDir, { recursive: true });
    const longContent = "# Header\n\n" + "x".repeat(5000);
    fs.writeFileSync(path.join(summaryDir, "ANALYSIS_SUMMARY.md"), longContent);

    const res = await request(buildApp()).get(
      `/api/guideline-improvement/${TASK_ID}/analysis-summary`,
    );
    expect(res.status).toBe(200);
    expect(res.text.length).toBe(longContent.length);
    expect(res.text).toBe(longContent);
  });
});
