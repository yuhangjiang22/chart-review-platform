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

  it("DELETE removes a version (re-activating the parent when it was active)", async () => {
    // active is s2 (parent s1) → delete it; parent s1 becomes active + re-materialized
    const res = await route("DELETE", "/api/rubric/:taskId/sessions/:sessionId/versions/:versionId")
      .handler(null, {} as never, { taskId: "x", sessionId: "s1", versionId: "s2" }, new URLSearchParams());
    expect((res as { active: string }).active).toBe("s1");
    const fork = sessionRubricRoot("x", "s1");
    expect(fs.readFileSync(path.join(fork, "references", "criteria", "f.md"), "utf8")).toBe("one");
    const log = await route("GET", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler(null, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect((log as { versions: { id: string }[] }).versions.map((v) => v.id)).toEqual(["s1"]);
  });

  it("DELETE refuses the base (fork-root) version", async () => {
    await expect(
      route("DELETE", "/api/rubric/:taskId/sessions/:sessionId/versions/:versionId")
        .handler(null, {} as never, { taskId: "x", sessionId: "s1", versionId: "s1" }, new URLSearchParams()),
    ).rejects.toThrow(/base/i);
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

  it("POST promote reports unchanged (no new version) when the session matches the baseline", async () => {
    const base = baselineRubricRoot("x");
    fs.mkdirSync(path.join(base, "references", "criteria"), { recursive: true });
    fs.writeFileSync(path.join(base, "references", "criteria", "f.md"), "two"); // == session s1's active s2
    snapshotVersion(base, { prefix: "v", source: "seed", by: "y", now: "2026-06-15T00:00:00Z" }); // v1 = "two"
    const res = (await route("POST", "/api/rubric/:taskId/promote")
      .handler({ session_id: "s1" }, {} as never, { taskId: "x" }, new URLSearchParams())) as {
      baseline_version: string; unchanged: boolean;
    };
    expect(res.unchanged).toBe(true);
    expect(res.baseline_version).toBe("v1"); // dedup → no new baseline version
    expect(getActiveVersion(base)).toBe("v1");
  });

  it("GET reports dirty=true when the working copy diverges from the active version", async () => {
    const fork = sessionRubricRoot("x", "s1");
    fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "edited-since-s2");
    const res = await route("GET", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler(null, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect((res as { dirty: boolean }).dirty).toBe(true);
  });

  it("POST versions snapshots the working draft as a new version", async () => {
    const fork = sessionRubricRoot("x", "s1");
    fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "draft-edit");
    const res = await route("POST", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler({ note: "my checkpoint" }, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    const body = res as { version: { id: string; source: string }; unchanged: boolean };
    expect(body.unchanged).toBe(false);
    expect(body.version.source).toBe("my checkpoint");
    expect(getActiveVersion(fork)).toBe(body.version.id);
  });

  it("POST versions is a no-op (unchanged) when the draft matches the active version", async () => {
    const res = await route("POST", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler({}, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect((res as { unchanged: boolean }).unchanged).toBe(true);
  });

  it("GET draft-diff returns the per-file line diff of the working draft", async () => {
    const fork = sessionRubricRoot("x", "s1");
    fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "two\nEXTRA");
    const res = await route("GET", "/api/rubric/:taskId/sessions/:sessionId/draft-diff")
      .handler(null, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    const body = res as { changes: Array<{ file: string; added: number }> };
    expect(body.changes.some((c) => c.file === "criteria/f.md" && c.added >= 1)).toBe(true);
  });

  it("POST draft/discard restores one field + clears dirty", async () => {
    const fork = sessionRubricRoot("x", "s1");
    fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "two\nEXTRA");
    await route("POST", "/api/rubric/:taskId/sessions/:sessionId/draft/discard")
      .handler({ file: "criteria/f.md" }, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect(fs.readFileSync(path.join(fork, "references", "criteria", "f.md"), "utf8")).toBe("two");
    const v = await route("GET", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler(null, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect((v as { dirty: boolean }).dirty).toBe(false);
  });
});
