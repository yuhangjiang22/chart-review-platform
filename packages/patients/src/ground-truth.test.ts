import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// patientDir() calls patientsRoot() which reads CHART_REVIEW_PATIENTS_ROOT at
// call time (it's a function, not a frozen const). So we can inject the temp
// dir via this env var even after module import.  CHART_REVIEW_PLATFORM_ROOT
// and CORPUS_ROOT are frozen at import time, so those would be too late.

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gt-"));
  process.env.CHART_REVIEW_PATIENTS_ROOT = tmp;
  const pdir = path.join(tmp, "p1");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, "ground_truth.json"), JSON.stringify({
    patient_id: "p1",
    leaf_answers: { apoe4: "1" },
    note_answers: { "n1": { apoe4: "1" }, "n2": { apoe4: "NA" } },
  }));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PATIENTS_ROOT;
});

describe("readGroundTruth", () => {
  it("returns leaf_answers and note_answers", async () => {
    const { readGroundTruth } = await import("./index.js");
    const gt = readGroundTruth("p1");
    expect(gt?.leaf_answers).toEqual({ apoe4: "1" });
    expect(gt?.note_answers?.["n2"]).toEqual({ apoe4: "NA" });
  });
  it("returns null for a patient with no ground_truth.json", async () => {
    const { readGroundTruth } = await import("./index.js");
    expect(readGroundTruth("nope")).toBeNull();
  });
});
