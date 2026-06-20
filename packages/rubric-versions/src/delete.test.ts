import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotVersion, deleteVersion, readVersionLog } from "./index.js";

let root: string;
const fmd = (root: string) => path.join(root, "references", "criteria", "f.md");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-del-"));
  fs.mkdirSync(path.dirname(fmd(root)), { recursive: true });
  const snap = (text: string, src: string) => {
    fs.writeFileSync(fmd(root), text);
    snapshotVersion(root, { prefix: "s", source: src, by: "y", now: "t" });
  };
  snap("one", "fork:v1");   // s1 (base, parent=null)
  snap("two", "edit");      // s2 (parent s1)
  snap("three", "edit");    // s3 (parent s2, active)
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("deleteVersion", () => {
  it("deletes a middle version, re-parents children, drops the snapshot", () => {
    deleteVersion(root, "s2");
    const log = readVersionLog(root)!;
    expect(log.versions.map((v) => v.id)).toEqual(["s1", "s3"]);
    expect(log.versions.find((v) => v.id === "s3")!.parent).toBe("s1"); // re-parented from s2
    expect(fs.existsSync(path.join(root, "versions", "s2"))).toBe(false);
    expect(log.active).toBe("s3"); // unchanged (s2 wasn't active)
  });

  it("refuses to delete the base version (s1)", () => {
    expect(() => deleteVersion(root, "s1")).toThrow(/base/i);
    expect(readVersionLog(root)!.versions.map((v) => v.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("deleting the ACTIVE version re-materializes + activates its parent", () => {
    deleteVersion(root, "s3"); // s3 is active, parent s2
    const log = readVersionLog(root)!;
    expect(log.active).toBe("s2");
    expect(log.versions.map((v) => v.id)).toEqual(["s1", "s2"]);
    expect(fs.readFileSync(fmd(root), "utf8")).toBe("two"); // working copy is s2's content
  });

  it("throws on an unknown version", () => {
    expect(() => deleteVersion(root, "s9")).toThrow(/no such version/);
  });

  it("assigns a fresh, non-colliding id after a delete (max+1, not count+1)", () => {
    // s1, s2, s3 exist. Delete the middle one → s1, s3 (count 2). A naive
    // count+1 nextId would re-issue "s3" and collide.
    deleteVersion(root, "s2");
    fs.writeFileSync(fmd(root), "four");
    const v = snapshotVersion(root, { prefix: "s", source: "edit", by: "y", now: "t" });
    expect(v.id).toBe("s4"); // NOT "s3" (already taken)
    const ids = readVersionLog(root)!.versions.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });
});
