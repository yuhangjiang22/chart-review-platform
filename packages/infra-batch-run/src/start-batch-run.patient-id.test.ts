import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBatchRun } from "./runs.js";

// A patient_id becomes a DIRECTORY NAME under var/runs/<run>/per_patient/, and
// that path does not go through patientDir, whose resolve-and-compare guard would
// have caught it. startBatchRun checked only non-emptiness, so run
// 2026-08-24T15-10-52-705Z died with:
//
//   ENAMETOOLONG: name too long, mkdir '.../per_patient/patient_real_asthma_a414…
//   patient_real_asthma_d189… <thirty ids> /agents'
//
// Thirty ids had arrived as ONE whitespace-joined string — a caller quoting its
// entire argument list — and the platform tried to create a directory named after
// all of them. These run before the task is loaded, so no fixture is needed.
// A THROWAWAY RUNS ROOT, because the last case below passes VALID ids — and
// getting past the id guard is exactly what it asserts, which means
// startBatchRun really starts. Without this, every full-suite execution left
// three run directories in the developer's OWN var/runs, marked running and then
// abandoned when the task load failed: 22 of them accumulated in one day, showing
// as phantom RUNNING badges in the UI and needing the orphan reconciler to clear
// them. A test that manufactures the exact stale-state problem the reconciler
// exists to fix is not a cost worth paying for coverage.
let runsRoot: string;
let prevRunsRoot: string | undefined;

beforeAll(() => {
  runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runs-patient-id-"));
  prevRunsRoot = process.env.CHART_REVIEW_RUNS_ROOT;
  process.env.CHART_REVIEW_RUNS_ROOT = runsRoot;
});

afterAll(() => {
  if (prevRunsRoot === undefined) delete process.env.CHART_REVIEW_RUNS_ROOT;
  else process.env.CHART_REVIEW_RUNS_ROOT = prevRunsRoot;
  fs.rmSync(runsRoot, { recursive: true, force: true });
});

describe("startBatchRun rejects a patient_id that is not a path component", () => {
  const run = (patient_ids: unknown[]) =>
    () => startBatchRun({ task_id: "asthma-adherence", patient_ids: patient_ids as string[],
      started_by: "audit-test" });

  it("the actual bug: many ids joined by whitespace", () => {
    const joined = ["a414d49f29bf", "d189d08b5041", "7b2715154864"]
      .map((h) => `patient_real_asthma_${h}`).join(" ");
    expect(run([joined])).toThrow(/invalid patient_id/);
    // The message must point at the CALLER, not the filesystem — ENAMETOOLONG
    // reads as a disk problem and sent the original diagnosis the wrong way.
    expect(run([joined])).toThrow(/whitespace; did you pass a quoted list as ONE argument\?/);
  });

  it("a path separator or dot-dot cannot reach mkdir", () => {
    for (const bad of ["../escape", "a/b", "a\\b", "..", "."]) {
      expect(run([bad]), bad).toThrow(/invalid patient_id/);
    }
  });

  it("a non-string never reaches the filesystem either", () => {
    for (const bad of [null, undefined, 42, {}]) {
      expect(run([bad])).toThrow(/invalid patient_id/);
    }
  });

  it("truncates a long id in the message rather than echoing all of it", () => {
    const long = "x".repeat(500);
    try { run([long])(); expect.fail("should have thrown"); }
    catch (e) { expect((e as Error).message.length).toBeLessThan(200); }
  });

  it("still rejects an empty list, and accepts the shapes the corpus uses", () => {
    expect(run([])).toThrow(/patient_ids must be non-empty/);
    // Past the id check, so it fails on the task instead — which is what proves
    // these ids were accepted. All 284 corpus ids are [a-z0-9_]+; hyphens and
    // capitals are allowed for a site that uses them.
    for (const ok of ["patient_fake_asthma_01", "synth_asthma_0154890f1274", "Site-A_123"]) {
      expect(run([ok]), ok).not.toThrow(/invalid patient_id/);
    }
  });
});
