import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotVersion, draftDiffersFromActive } from "./index.js";

let root: string;
const fmd = (r: string) => path.join(r, "references", "criteria", "f.md");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-dirty-"));
  fs.mkdirSync(path.dirname(fmd(root)), { recursive: true });
  fs.writeFileSync(fmd(root), "one");
  snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: "t" }); // s1
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("draftDiffersFromActive", () => {
  it("is false right after a snapshot (draft == active)", () => {
    expect(draftDiffersFromActive(root)).toBe(false);
  });
  it("is true after the working copy is edited", () => {
    fs.writeFileSync(fmd(root), "two");
    expect(draftDiffersFromActive(root)).toBe(true);
  });
  it("is false again after re-snapshotting the edit", () => {
    fs.writeFileSync(fmd(root), "two");
    snapshotVersion(root, { prefix: "s", source: "edit", by: "y", now: "t" });
    expect(draftDiffersFromActive(root)).toBe(false);
  });
  it("is false when there is no version log yet (nothing to compare)", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rv-empty-"));
    fs.mkdirSync(path.join(empty, "references"), { recursive: true });
    expect(draftDiffersFromActive(empty)).toBe(false);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
