import { describe, it, expect } from "vitest";
import type { GuidelineVersion, PilotManifest } from "../domain/iter/index.js";

describe("GuidelineVersion type alias", () => {
  it("GuidelineVersion is assignable to PilotManifest", () => {
    const gv: GuidelineVersion = {
      task_id: "t1",
      iter_id: "iter_001",
      iter_num: 1,
      run_id: "run_001",
      guideline_sha: "abc",
      started_at: "2026-05-06T00:00:00Z",
      started_by: "method",
      state: "running",
    };
    const pm: PilotManifest = gv;
    expect(pm.iter_id).toBe("iter_001");
  });

  it("PilotManifest is assignable to GuidelineVersion", () => {
    const pm: PilotManifest = {
      task_id: "t1",
      iter_id: "iter_001",
      iter_num: 1,
      run_id: "run_001",
      guideline_sha: "abc",
      started_at: "2026-05-06T00:00:00Z",
      started_by: "method",
      state: "running",
    };
    const gv: GuidelineVersion = pm;
    expect(gv.task_id).toBe("t1");
  });
});
