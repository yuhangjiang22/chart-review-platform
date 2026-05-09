import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import os from "os";
import { transitionIterToRevising, getPilotManifest } from "../domain/iter/index.js";
import type { PilotManifest } from "../domain/iter/index.js";

// Use a temp directory for tests
const TEST_PLATFORM_ROOT = path.join(os.tmpdir(), `chart-review-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

// Save original env
const originalPlatformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;

function setupTest(): void {
  // Set the platform root to our test directory
  process.env.CHART_REVIEW_PLATFORM_ROOT = TEST_PLATFORM_ROOT;

  // Create the test directory structure
  const dir = path.join(TEST_PLATFORM_ROOT, ".claude", "skills");
  fs.mkdirSync(dir, { recursive: true });
}

function setupTestManifest(taskId: string, iterId: string, manifest: PilotManifest): void {
  const dir = path.join(TEST_PLATFORM_ROOT, ".claude", "skills", `chart-review-${taskId}`, "pilots", iterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function cleanupTest(): void {
  if (fs.existsSync(TEST_PLATFORM_ROOT)) {
    fs.rmSync(TEST_PLATFORM_ROOT, { recursive: true, force: true });
  }
  // Restore original env
  if (originalPlatformRoot !== undefined) {
    process.env.CHART_REVIEW_PLATFORM_ROOT = originalPlatformRoot;
  } else {
    delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  }
}

const BASE_MANIFEST: PilotManifest = {
  task_id: "t1",
  iter_id: "iter_001",
  iter_num: 1,
  run_id: "r1",
  guideline_sha: "abc",
  started_at: "2026-05-06T00:00:00Z",
  started_by: "method",
  state: "complete",
};

describe("transitionIterToRevising", () => {
  beforeEach(() => {
    setupTest();
  });

  afterEach(() => {
    cleanupTest();
  });

  it("transitions complete iter to revising", () => {
    setupTestManifest("t1", "iter_001", BASE_MANIFEST);

    // Verify test setup
    const m = getPilotManifest("t1", "iter_001");
    expect(m).toBeDefined();
    expect(m?.state).toBe("complete");

    // Now test the transition
    const result = transitionIterToRevising("t1", "iter_001");
    expect(result.state).toBe("revising");
  });

  it("throws when iter is locked", () => {
    setupTestManifest("t1", "iter_001", { ...BASE_MANIFEST, state: "locked" });
    expect(() => transitionIterToRevising("t1", "iter_001")).toThrow(/locked/);
  });

  it("throws when iter not found", () => {
    expect(() => transitionIterToRevising("t1", "iter_999")).toThrow(/not found/);
  });
});
