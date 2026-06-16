import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rubricVersionRoutes } from "./rubric-version-routes.js";
import { snapshotVersion, getActiveVersion } from "@chart-review/rubric-versions";
import { sessionRubricRoot, baselineRubricRoot } from "@chart-review/rubric";

function route(method: string, pattern: string) {
  const r = rubricVersionRoutes.find((x) => x.method === method && x.pattern === pattern);
  if (!r) throw new Error(`no route ${method} ${pattern}`);
  return r;
}

let root: string;
let prevRoot: string | undefined;
let prevOverride: string | undefined;

beforeEach(() => {
  prevRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
  prevOverride = process.env.CHART_REVIEW_RUBRIC_ROOT;
  delete process.env.CHART_REVIEW_RUBRIC_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gl-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = root;
  const fork = sessionRubricRoot("x", "s1");
  fs.mkdirSync(path.join(fork, "references", "criteria"), { recursive: true });
  fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "one");
  snapshotVersion(fork, { prefix: "s", source: "fork:v1", by: "y", now: "2026-06-15T00:00:00Z" }); // s1
  fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "two");
  snapshotVersion(fork, { prefix: "s", source: "edit", by: "y", now: "2026-06-15T00:00:00Z" });     // s2
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT; else process.env.CHART_REVIEW_PLATFORM_ROOT = prevRoot;
  if (prevOverride === undefined) delete process.env.CHART_REVIEW_RUBRIC_ROOT; else process.env.CHART_REVIEW_RUBRIC_ROOT = prevOverride;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("rubric version routes", () => {
  it("GET lists the session's versions with the active marked", async () => {
    const res = await route("GET", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler(null, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect((res as { active: string }).active).toBe("s2");
    expect((res as { versions: unknown[] }).versions).toHaveLength(2);
  });

  it("POST switch moves the active pointer + re-materializes the working copy", async () => {
    await route("POST", "/api/rubric/:taskId/sessions/:sessionId/switch")
      .handler({ version: "s1" }, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    const fork = sessionRubricRoot("x", "s1");
    expect(fs.readFileSync(path.join(fork, "references", "criteria", "f.md"), "utf8")).toBe("one");
    const log = await route("GET", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler(null, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect((log as { active: string }).active).toBe("s1");
  });

  it("POST switch rejects an unknown version", async () => {
    await expect(
      route("POST", "/api/rubric/:taskId/sessions/:sessionId/switch")
        .handler({ version: "s99" }, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams()),
    ).rejects.toThrow(/no such version/i);
  });

  it("POST promote creates a new baseline version from the session's active version", async () => {
    const base = baselineRubricRoot("x");
    fs.mkdirSync(path.join(base, "references", "criteria"), { recursive: true });
    fs.writeFileSync(path.join(base, "references", "criteria", "f.md"), "baseline-one");
    snapshotVersion(base, { prefix: "v", source: "seed", by: "y", now: "2026-06-15T00:00:00Z" }); // v1
    // session s1's active version is s2 ("two")
    const res = await route("POST", "/api/rubric/:taskId/promote")
      .handler({ session_id: "s1" }, {} as never, { taskId: "x" }, new URLSearchParams());
    expect((res as { baseline_version: string }).baseline_version).toBe("v2");
    expect(getActiveVersion(base)).toBe("v2");
    expect(fs.readFileSync(path.join(base, "references", "criteria", "f.md"), "utf8")).toBe("two");
  });
});
