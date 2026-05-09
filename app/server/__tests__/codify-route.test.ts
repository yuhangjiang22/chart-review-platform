import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";

import { codifyRouter } from "../adapters/http/codify-routes.js";

describe("codify route", () => {
  let tmp: string;
  let prevPlatformRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "codify-test-"));
    // Layout: <tmp>/.claude/skills/chart-review-locked-task/  +  <tmp>/reviews/...
    const skillsDir = path.join(tmp, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    cpSync(
      path.resolve(thisDir, "..", "..", "..", "lib", "tests", "fixtures", "codify", "locked-task"),
      path.join(skillsDir, "chart-review-locked-task"),
      { recursive: true },
    );
    cpSync(
      path.resolve(thisDir, "..", "..", "..", "lib", "tests", "fixtures", "codify", "reviews"),
      path.join(tmp, "reviews"),
      { recursive: true },
    );
    prevPlatformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
    process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  });

  afterEach(() => {
    if (prevPlatformRoot === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    else process.env.CHART_REVIEW_PLATFORM_ROOT = prevPlatformRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeApp() {
    const app = express();
    app.use(codifyRouter());
    return app;
  }

  it("POST /api/guideline-codify/:taskId returns success on valid task", async () => {
    const res = await request(makeApp())
      .post("/api/guideline-codify/locked-task")
      .send();
    expect(res.status).toBe(200);
    expect(res.body.cohort_size).toBe(4);
    expect(Array.isArray(res.body.written_files)).toBe(true);
    expect(res.body.written_files.some((f: string) => f.includes("kw_lung_pathology.md"))).toBe(true);
  });

  it("writes the keyword_set file to disk", async () => {
    await request(makeApp()).post("/api/guideline-codify/locked-task").send();
    const fp = path.join(
      tmp, ".claude", "skills", "chart-review-locked-task",
      "references", "keyword_sets", "kw_lung_pathology.md",
    );
    const text = readFileSync(fp, "utf8");
    expect(text).toContain("biopsy");
  });

  it("returns 400 on empty cohort", async () => {
    // Strip reviews to force the empty-cohort path.
    rmSync(path.join(tmp, "reviews"), { recursive: true, force: true });
    mkdirSync(path.join(tmp, "reviews"));
    const res = await request(makeApp())
      .post("/api/guideline-codify/locked-task")
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no validated patients/);
  });

  it("returns 404 when task package is missing", async () => {
    const res = await request(makeApp())
      .post("/api/guideline-codify/no-such-task")
      .send();
    expect(res.status).toBe(404);
  });
});
