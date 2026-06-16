import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  snapshotVersion,
  readVersionLog,
  getActiveVersion,
  switchVersion,
  diffVersions,
  forkFrom,
} from "./index.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-"));
  fs.mkdirSync(path.join(root, "references", "criteria"), { recursive: true });
  fs.writeFileSync(path.join(root, "references", "criteria", "f.md"), "v-one");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = "2026-06-15T00:00:00.000Z";

describe("snapshotVersion", () => {
  it("creates s1 from the working copy and sets it active", () => {
    const v = snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "yuhang", now: NOW });
    expect(v.id).toBe("s1");
    expect(getActiveVersion(root)).toBe("s1");
    expect(fs.readFileSync(path.join(root, "versions", "s1", "references", "criteria", "f.md"), "utf8")).toBe("v-one");
    const log = readVersionLog(root)!;
    expect(log.versions).toHaveLength(1);
    expect(log.versions[0].source).toBe("fork:v1");
    expect(log.versions[0].parent).toBeNull();
  });

  it("dedups: re-snapshotting identical content returns the active version, no new id", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "yuhang", now: NOW });
    const again = snapshotVersion(root, { prefix: "s", source: "author-edit", by: "yuhang", now: NOW });
    expect(again.id).toBe("s1");
    expect(readVersionLog(root)!.versions).toHaveLength(1);
  });

  it("a changed working copy snapshots s2 with parent s1", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "yuhang", now: NOW });
    fs.writeFileSync(path.join(root, "references", "criteria", "f.md"), "v-two");
    const v2 = snapshotVersion(root, { prefix: "s", source: "refine:cancer_type", by: "yuhang", now: NOW });
    expect(v2.id).toBe("s2");
    expect(v2.parent).toBe("s1");
    expect(getActiveVersion(root)).toBe("s2");
  });
});

describe("switchVersion", () => {
  it("re-materializes the working copy from a chosen version, non-destructively", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: NOW });
    fs.writeFileSync(path.join(root, "references", "criteria", "f.md"), "v-two");
    snapshotVersion(root, { prefix: "s", source: "edit", by: "y", now: NOW });
    switchVersion(root, "s1");
    expect(fs.readFileSync(path.join(root, "references", "criteria", "f.md"), "utf8")).toBe("v-one");
    expect(getActiveVersion(root)).toBe("s1");
    expect(fs.readFileSync(path.join(root, "versions", "s2", "references", "criteria", "f.md"), "utf8")).toBe("v-two");
  });
  it("throws on an unknown version id", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: NOW });
    expect(() => switchVersion(root, "s99")).toThrow(/no such version/i);
  });
  it("editing after a switch-back branches with the switched parent", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: NOW }); // s1 v-one
    fs.writeFileSync(path.join(root, "references", "criteria", "f.md"), "v-two");
    snapshotVersion(root, { prefix: "s", source: "edit", by: "y", now: NOW });     // s2 v-two
    switchVersion(root, "s1");
    fs.writeFileSync(path.join(root, "references", "criteria", "f.md"), "v-three");
    const v3 = snapshotVersion(root, { prefix: "s", source: "edit", by: "y", now: NOW });
    expect(v3.id).toBe("s3");
    expect(v3.parent).toBe("s1"); // branched from the switched-to version
  });
});

describe("diffVersions", () => {
  it("reports which criteria files changed between two versions", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: NOW });
    fs.writeFileSync(path.join(root, "references", "criteria", "f.md"), "v-two");
    snapshotVersion(root, { prefix: "s", source: "edit", by: "y", now: NOW });
    expect(diffVersions(root, "s1", "s2")).toEqual([{ file: "criteria/f.md", status: "changed" }]);
  });
});

describe("forkFrom", () => {
  it("copies a source references/ into the working copy + snapshots s1", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "base-"));
    fs.mkdirSync(path.join(base, "criteria"), { recursive: true });
    fs.writeFileSync(path.join(base, "criteria", "f.md"), "from-base");
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), "fork-"));
    forkFrom(base, dst, { source: "fork:v1", by: "y", now: NOW });
    expect(fs.readFileSync(path.join(dst, "references", "criteria", "f.md"), "utf8")).toBe("from-base");
    expect(getActiveVersion(dst)).toBe("s1");
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });
});
