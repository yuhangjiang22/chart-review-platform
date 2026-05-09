// app/server/__tests__/sampling.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { stratifiedSample } from "../sampling";

let CORPUS: string;
beforeEach(() => {
  CORPUS = fs.mkdtempSync(path.join(os.tmpdir(), "sampling-test-"));
});
afterEach(() => fs.rmSync(CORPUS, { recursive: true, force: true }));

function seedPatient(pid: string, structured: Record<string, unknown>) {
  const dir = path.join(CORPUS, pid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "structured.json"), JSON.stringify(structured));
}

describe("stratifiedSample", () => {
  it("samples uniform-random when stratifyBy is empty", () => {
    for (let i = 0; i < 100; i++) seedPatient(`p${i}`, { age: 50 + (i % 30) });
    const result = stratifiedSample({
      taskId: "t1", reviewsRoot: "", patientCorpusRoot: CORPUS,
      sampleSize: 20, stratifyBy: [], seed: 42,
    });
    expect(result.total_eligible).toBe(100);
    expect(result.sampled).toHaveLength(20);
    expect(result.strata).toHaveLength(1);  // single stratum
  });

  it("samples proportionally per stratum", () => {
    // 60 patients age_bucket "<65", 40 patients age_bucket "65+"
    for (let i = 0; i < 60; i++) seedPatient(`p_lt65_${i}`, { age_bucket: "<65" });
    for (let i = 0; i < 40; i++) seedPatient(`p_ge65_${i}`, { age_bucket: "65+" });

    const result = stratifiedSample({
      taskId: "t1", reviewsRoot: "", patientCorpusRoot: CORPUS,
      sampleSize: 20, stratifyBy: ["age_bucket"], seed: 42,
    });
    expect(result.total_eligible).toBe(100);
    expect(result.strata).toHaveLength(2);
    expect(result.sampled.length).toBeGreaterThanOrEqual(20);

    // Roughly 12 from <65, 8 from 65+ (proportional)
    const lt65Sampled = result.sampled.filter((p) => p.startsWith("p_lt65")).length;
    const ge65Sampled = result.sampled.filter((p) => p.startsWith("p_ge65")).length;
    expect(lt65Sampled).toBeGreaterThanOrEqual(10);
    expect(lt65Sampled).toBeLessThanOrEqual(14);
    expect(ge65Sampled).toBeGreaterThanOrEqual(6);
    expect(ge65Sampled).toBeLessThanOrEqual(10);
  });

  it("excludes patients missing a stratification key (records in skipped[])", () => {
    seedPatient("p1", { age_bucket: "<65" });
    seedPatient("p2", { /* no age_bucket */ });
    const result = stratifiedSample({
      taskId: "t1", reviewsRoot: "", patientCorpusRoot: CORPUS,
      sampleSize: 10, stratifyBy: ["age_bucket"], seed: 42,
    });
    expect(result.total_eligible).toBe(1);
    expect(result.skipped.find((s) => s.patient_id === "p2")).toBeDefined();
  });

  it("returns same sample for same seed (reproducibility)", () => {
    for (let i = 0; i < 50; i++) seedPatient(`p${i}`, { x: i % 5 });
    const a = stratifiedSample({ taskId: "t1", reviewsRoot: "", patientCorpusRoot: CORPUS, sampleSize: 10, stratifyBy: ["x"], seed: 7 });
    const b = stratifiedSample({ taskId: "t1", reviewsRoot: "", patientCorpusRoot: CORPUS, sampleSize: 10, stratifyBy: ["x"], seed: 7 });
    expect(a.sampled.sort()).toEqual(b.sampled.sort());
  });
});
