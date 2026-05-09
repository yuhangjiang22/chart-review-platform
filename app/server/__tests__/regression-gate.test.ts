import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checkRegression } from "../domain/iter/regression-gate.js";

let tmp: string;
const TID = "ph";

function seedSkill() {
  const skillDir = path.join(tmp, ".claude/skills", `chart-review-${TID}`);
  fs.mkdirSync(path.join(skillDir, "references/criteria"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "meta.yaml"), "task_type: phenotype_validation\n");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: chart-review-ph\ndescription: t\n---\n");
  for (const f of ["f1", "f2"]) {
    fs.writeFileSync(path.join(skillDir, "references/criteria", `${f}.md`),
      `---\nfield_id: ${f}\nanswer_kind: boolean\n---\n`);
  }
}

function seedIterManifest(iterId: string, patientIds: string[]) {
  const dir = path.join(tmp, ".claude/skills", `chart-review-${TID}`, "pilots", iterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    iter_id: iterId,
    task_id: TID,
    state: "complete",
    patient_ids: patientIds,
    started_at: "2026-05-01T00:00:00Z",
  }));
}

function seedReview(patientId: string, answers: Record<string, unknown>) {
  const dir = path.join(tmp, "reviews", patientId, TID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    patient_id: patientId,
    task_id: TID,
    field_assessments: Object.entries(answers).map(([field_id, answer]) => ({
      field_id, answer, source: "reviewer", status: "approved",
    })),
  }));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rg-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  process.env.CHART_REVIEW_REVIEWS_ROOT = path.join(tmp, "reviews");
  seedSkill();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

describe("checkRegression", () => {
  it("returns no regressions when current agent matches all prior ground truth", async () => {
    seedIterManifest("iter_001", ["p1", "p2"]);
    seedReview("p1", { f1: true, f2: false });
    seedReview("p2", { f1: false, f2: true });

    const result = await checkRegression({
      taskId: TID,
      excludeIterIds: [],
      reRunPatient: async (_tid, pid) => {
        if (pid === "p1") return { f1: true, f2: false };
        if (pid === "p2") return { f1: false, f2: true };
        return {};
      },
    });

    expect(result.regressions).toEqual([]);
    expect(result.gate).toBe("clear");
    expect(result.patients_checked).toBe(2);
  });

  it("blocks when any prior patient now disagrees on any criterion", async () => {
    seedIterManifest("iter_001", ["p1"]);
    seedIterManifest("iter_002", ["p2"]);
    seedReview("p1", { f1: true, f2: false });
    seedReview("p2", { f1: false, f2: true });

    const result = await checkRegression({
      taskId: TID,
      excludeIterIds: [],
      reRunPatient: async (_tid, pid) => {
        if (pid === "p1") return { f1: true,  f2: true };  // f2 regressed
        if (pid === "p2") return { f1: false, f2: true };
        return {};
      },
    });

    expect(result.gate).toBe("blocked");
    expect(result.regressions).toEqual([
      { patient_id: "p1", field_id: "f2", was: false, now: true },
    ]);
  });

  it("excludes the iters in excludeIterIds (e.g., the current iter)", async () => {
    seedIterManifest("iter_001", ["p1"]);
    seedIterManifest("iter_002", ["p2"]);
    seedReview("p1", { f1: true });
    seedReview("p2", { f1: false });

    const result = await checkRegression({
      taskId: TID,
      excludeIterIds: ["iter_002"],
      reRunPatient: async (_tid, pid) => {
        return pid === "p1" ? { f1: true } : { f1: true /* would regress, but excluded */ };
      },
    });

    expect(result.gate).toBe("clear");
    expect(result.patients_checked).toBe(1);
  });
});
