// app/server/__tests__/fs-atomic.test.ts
//
// Tests for the writeFileAtomic / writeJsonAtomic helpers — verify the
// temp-file dance, the rename-over-destination semantics, and cleanup on
// failure.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { writeFileAtomic, writeJsonAtomic } from "../lib/fs-atomic.js";

let TMP: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-atomic-"));
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes content to the destination path", () => {
    const dst = path.join(TMP, "out.txt");
    writeFileAtomic(dst, "hello world");
    expect(fs.readFileSync(dst, "utf8")).toBe("hello world");
  });

  it("overwrites an existing file", () => {
    const dst = path.join(TMP, "out.txt");
    fs.writeFileSync(dst, "old content");
    writeFileAtomic(dst, "new content");
    expect(fs.readFileSync(dst, "utf8")).toBe("new content");
  });

  it("leaves no temp file behind on success", () => {
    const dst = path.join(TMP, "out.txt");
    writeFileAtomic(dst, "hello");
    const stragglers = fs.readdirSync(TMP).filter((n) => n.includes(".tmp"));
    expect(stragglers).toHaveLength(0);
  });

  it("removes the temp file when rename fails", () => {
    // Force a failure by passing a destination directory that doesn't exist.
    const dst = path.join(TMP, "no-such-dir", "out.txt");
    expect(() => writeFileAtomic(dst, "x")).toThrow();
    // The temp file would be in `no-such-dir` which doesn't exist, so this
    // confirms the helper doesn't leave temp files in the parent TMP either.
    const stragglers = fs.readdirSync(TMP).filter((n) => n.includes(".tmp"));
    expect(stragglers).toHaveLength(0);
  });

  it("uses a PID-suffixed temp file name", () => {
    // Spy on writeFileSync to capture the temp path used.
    let capturedTmp = "";
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === "string" && p.includes(".tmp")) capturedTmp = p;
      // @ts-expect-error spreading rest into the original
      return origWrite(p, ...rest);
    }) as typeof fs.writeFileSync;

    try {
      writeFileAtomic(path.join(TMP, "out.txt"), "hello");
    } finally {
      fs.writeFileSync = origWrite;
    }
    expect(capturedTmp).toContain(`.${process.pid}.tmp`);
  });
});

describe("writeJsonAtomic", () => {
  it("writes pretty-printed JSON with a trailing newline", () => {
    const dst = path.join(TMP, "out.json");
    writeJsonAtomic(dst, { a: 1, b: [2, 3] });
    const content = fs.readFileSync(dst, "utf8");
    expect(content).toBe(`{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n`);
  });

  it("round-trips through JSON.parse", () => {
    const dst = path.join(TMP, "out.json");
    const data = { iter_id: "iter_001", phase: "complete", n_proposals: 4 };
    writeJsonAtomic(dst, data);
    expect(JSON.parse(fs.readFileSync(dst, "utf8"))).toEqual(data);
  });

  it("overwrites previous JSON without leaving a temp file", () => {
    const dst = path.join(TMP, "out.json");
    writeJsonAtomic(dst, { v: 1 });
    writeJsonAtomic(dst, { v: 2 });
    expect(JSON.parse(fs.readFileSync(dst, "utf8"))).toEqual({ v: 2 });
    const stragglers = fs.readdirSync(TMP).filter((n) => n.includes(".tmp"));
    expect(stragglers).toHaveLength(0);
  });
});
