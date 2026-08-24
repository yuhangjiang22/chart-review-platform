import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// See ground-truth.test.ts: patientDir() calls patientsRoot() which reads
// CHART_REVIEW_PATIENTS_ROOT at call time, so we can inject a temp dir even
// after module import.

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anchors-"));
  process.env.CHART_REVIEW_PATIENTS_ROOT = tmp;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PATIENTS_ROOT;
  vi.restoreAllMocks();
});

describe("readAnchors", () => {
  it("reads two anchor lists, stripping the .json suffix", async () => {
    const { readAnchors } = await import("./index.js");
    const adir = path.join(tmp, "p1", "anchors");
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(adir, "visits.json"), JSON.stringify([{ date: "2024-01-01" }]));
    fs.writeFileSync(path.join(adir, "bursts.json"), JSON.stringify([{ date: "2024-02-01" }]));

    const out = readAnchors("p1");
    expect(Object.keys(out).sort()).toEqual(["bursts", "visits"]);
    expect(out.visits).toEqual([{ date: "2024-01-01" }]);
    expect(out.bursts).toEqual([{ date: "2024-02-01" }]);
  });

  it("skips a file whose JSON is not an array", async () => {
    const { readAnchors } = await import("./index.js");
    const adir = path.join(tmp, "p2", "anchors");
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(adir, "visits.json"), JSON.stringify({ not: "an array" }));

    const out = readAnchors("p2");
    expect(out).toEqual({});
  });

  it("skips an unparseable file and warns", async () => {
    const { readAnchors } = await import("./index.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adir = path.join(tmp, "p3", "anchors");
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(adir, "visits.json"), "{ not valid json");

    const out = readAnchors("p3");
    expect(out).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipping unparseable anchor list visits.json for p3"),
    );
  });

  it("returns {} when the anchors dir is missing", async () => {
    const { readAnchors } = await import("./index.js");
    fs.mkdirSync(path.join(tmp, "p4"), { recursive: true });
    expect(readAnchors("p4")).toEqual({});
  });
});
