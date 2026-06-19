import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotVersion, diffDraftAgainstActive } from "./index.js";

let root: string;
const crit = (r: string, name: string) => path.join(r, "references", "criteria", name);
function writeCrit(name: string, text: string) {
  fs.mkdirSync(path.dirname(crit(root, name)), { recursive: true });
  fs.writeFileSync(crit(root, name), text);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-dd-"));
  writeCrit("a.md", "line1\nline2");
  writeCrit("b.md", "keep");
  snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: "t" }); // s1 = active
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("diffDraftAgainstActive", () => {
  it("returns [] when the draft matches the active version", () => {
    expect(diffDraftAgainstActive(root)).toEqual([]);
  });
  it("reports an edited file with line-level diff + counts", () => {
    writeCrit("a.md", "line1\nline2\nline3");
    const d = diffDraftAgainstActive(root);
    expect(d).toHaveLength(1);
    expect(d[0].file).toBe("criteria/a.md");
    expect(d[0].status).toBe("changed");
    expect(d[0].added).toBe(1);
    expect(d[0].removed).toBe(0);
    expect(d[0].lines.some((l) => l.tag === "add" && l.text === "line3")).toBe(true);
  });
  it("reports added + removed files", () => {
    writeCrit("c.md", "new file");
    fs.rmSync(crit(root, "b.md"));
    const d = diffDraftAgainstActive(root);
    const byFile = Object.fromEntries(d.map((x) => [x.file, x.status]));
    expect(byFile["criteria/c.md"]).toBe("added");
    expect(byFile["criteria/b.md"]).toBe("removed");
  });
});
