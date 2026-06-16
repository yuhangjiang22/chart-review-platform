import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPlatformRoot } from "./index.js";

let prev: string | undefined;
beforeEach(() => { prev = process.env.CHART_REVIEW_PLATFORM_ROOT; delete process.env.CHART_REVIEW_PLATFORM_ROOT; });
afterEach(() => { if (prev === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT; else process.env.CHART_REVIEW_PLATFORM_ROOT = prev; });

describe("findPlatformRoot", () => {
  it("locates the root by the .claude/skills marker", () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "pr-"));
    fs.mkdirSync(path.join(r, ".claude", "skills"), { recursive: true });
    const deep = path.join(r, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    expect(findPlatformRoot(deep)).toBe(r);
    fs.rmSync(r, { recursive: true, force: true });
  });
  it("still locates the root by the legacy .agents/skills marker", () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "pr-"));
    fs.mkdirSync(path.join(r, ".agents", "skills"), { recursive: true });
    const deep = path.join(r, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    expect(findPlatformRoot(deep)).toBe(r);
    fs.rmSync(r, { recursive: true, force: true });
  });
});
