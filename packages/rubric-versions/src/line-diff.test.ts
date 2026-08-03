import { describe, it, expect } from "vitest";
import { diffLines } from "./line-diff.js";

describe("diffLines", () => {
  it("marks pure additions", () => {
    const d = diffLines("a\nb", "a\nb\nc");
    expect(d.lines).toEqual([
      { tag: "ctx", text: "a" },
      { tag: "ctx", text: "b" },
      { tag: "add", text: "c" },
    ]);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
  });

  it("marks a replacement as remove + add", () => {
    const d = diffLines("keep\nold line", "keep\nnew line one\nnew line two");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.lines.filter((l) => l.tag === "del").map((l) => l.text)).toEqual(["old line"]);
    expect(d.lines.filter((l) => l.tag === "add").map((l) => l.text)).toEqual(["new line one", "new line two"]);
  });

  it("identical text → no changes", () => {
    const d = diffLines("x\ny", "x\ny");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.lines.every((l) => l.tag === "ctx")).toBe(true);
  });
});
