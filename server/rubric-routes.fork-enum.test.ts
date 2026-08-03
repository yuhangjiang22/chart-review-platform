// Regression: GET /api/tasks/:taskId/rubric must read each criterion's enum (and
// prompt) from the criterion .md — NOT the baseline compiled task. Otherwise a
// session edit to the allowed answers is written by PUT but never read back (the
// UI always shows the baseline enum). Repro: point CHART_REVIEW_RUBRIC_ROOT at a
// criteria dir whose item_1 enum differs from the baseline; the GET must return
// the md's enum.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rubricRoutes } from "./rubric-routes.js";
import { buildCriterionMd } from "./lib/criterion-md.js";

const getRubric = rubricRoutes.find(
  (r) => r.method === "GET" && r.pattern === "/api/tasks/:taskId/rubric",
)!;

let tmp: string;
let prevRubricRoot: string | undefined;
let prevPlatform: string | undefined;

beforeEach(() => {
  prevRubricRoot = process.env.CHART_REVIEW_RUBRIC_ROOT;
  prevPlatform = process.env.CHART_REVIEW_PLATFORM_ROOT;
  // loadCompiledTask("rucam") reads the real baseline task (field list).
  process.env.CHART_REVIEW_PLATFORM_ROOT = process.cwd();
  // resolveRubricRoot honors this override first → the GET reads criteria here.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rr-"));
  const cdir = path.join(tmp, "references", "criteria");
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(
    path.join(cdir, "item_1_time_to_onset.md"),
    buildCriterionMd({
      field_id: "item_1_time_to_onset", prompt: "edited prompt",
      enumValues: ["2", "1", "0", "-1"],   // baseline is [2,1,0] — the edit adds -1
      definition: "D", extraction_guidance: "G", examples: "E",
    }),
  );
  process.env.CHART_REVIEW_RUBRIC_ROOT = tmp;
});

afterEach(() => {
  if (prevRubricRoot === undefined) delete process.env.CHART_REVIEW_RUBRIC_ROOT;
  else process.env.CHART_REVIEW_RUBRIC_ROOT = prevRubricRoot;
  if (prevPlatform === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  else process.env.CHART_REVIEW_PLATFORM_ROOT = prevPlatform;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("GET rubric — enum + prompt come from the criterion md, not the baseline", () => {
  it("returns the md's edited enum (incl -1) and prompt", async () => {
    const res = (await getRubric.handler(
      null, {} as never, { taskId: "rucam" }, new URLSearchParams(),
    )) as { fields: Array<{ field_id: string; enum: string[]; prompt: string }> };
    const f = res.fields.find((x) => x.field_id === "item_1_time_to_onset");
    expect(f).toBeTruthy();
    expect(f!.enum).toEqual(["2", "1", "0", "-1"]);   // pre-fix this was the baseline [2,1,0]
    expect(f!.prompt).toBe("edited prompt");
  });
});
